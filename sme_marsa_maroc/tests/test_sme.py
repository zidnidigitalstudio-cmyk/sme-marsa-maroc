"""
Tests automatisés (spécification §12.7) : conversions, décodage de registres,
qualification des mesures, tarification, régression SER, IPE, règles d'alerte.

Lancement :  python -m unittest discover -s tests -v
(utilise une base temporaire : n'affecte pas les données de l'application)
"""
import os
import sys
import tempfile
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
os.environ["SME_DATA_DIR"] = tempfile.mkdtemp(prefix="sme_test_")
os.environ["SME_BACKUP_DIR"] = os.path.join(os.environ["SME_DATA_DIR"], "bk")

import db          # noqa: E402
import energy      # noqa: E402
import engine      # noqa: E402
from modbus_tcp import (ModbusTCPServer, float32_to_regs, read_registers,   # noqa: E402
                        regs_to_float32, regs_to_uint32, uint32_to_regs)

DEFS = [
    {"grandeur": "P", "adresse": 100, "type": "float32", "echelle": 1.0, "min_valide": -50, "max_valide": 4000},
    {"grandeur": "PF", "adresse": 102, "type": "float32", "echelle": 1.0, "min_valide": 0, "max_valide": 1},
    {"grandeur": "E", "adresse": 104, "type": "uint32", "echelle": 0.1, "min_valide": 0, "max_valide": 4.3e8},
]


class TestConversions(unittest.TestCase):
    def test_float32_roundtrip(self):
        for v in (0.0, 1.5, -12.25, 1234.5):
            self.assertAlmostEqual(regs_to_float32(*float32_to_regs(v)), v, places=4)

    def test_uint32_roundtrip(self):
        for v in (0, 1, 65535, 65536, 4_000_000_001):
            self.assertEqual(regs_to_uint32(*uint32_to_regs(v)), v)

    def test_word_order_big_endian(self):
        self.assertEqual(uint32_to_regs(0x00010002), [1, 2])


class TestRegisters(unittest.TestCase):
    def test_encode_decode_with_scale(self):
        regs_map = engine.encode_registers(DEFS, {"P": 812.5, "PF": 0.91, "E": 123456.7})
        block = [regs_map[a] for a in range(100, 106)]
        dec = engine.decode_registers(DEFS, 100, block)
        self.assertAlmostEqual(dec["P"][0], 812.5, places=3)
        self.assertAlmostEqual(dec["E"][0], 123456.7, places=1)     # échelle 0,1 kWh
        self.assertTrue(all(q == "valide" for _, q in dec.values()))

    def test_out_of_range_is_invalid(self):
        regs_map = engine.encode_registers(DEFS, {"P": 10, "PF": 1.7, "E": 1})
        dec = engine.decode_registers(DEFS, 100, [regs_map[a] for a in range(100, 106)])
        self.assertEqual(dec["PF"][1], "invalide")

    def test_missing_register_is_absent(self):
        dec = engine.decode_registers(DEFS, 100, [0, 0])
        self.assertEqual(dec["E"], (None, "absente"))


class TestQualification(unittest.TestCase):
    def _dec(self, ts):
        return {"P": (100.0, "valide"), "U": (400.0, "valide"), "PF": (0.9, "valide"), "E": (10.0, "valide"), "TS": (ts, "valide")}

    def test_valid(self):
        q, motifs, ts_m = engine.classify(self._dec(1000.0), 1000.5, 5, engine._Hist())
        self.assertEqual((q, motifs, ts_m), ("valide", [], 1000.0))

    def test_clock_drift_is_suspect(self):
        q, motifs, _ = engine.classify(self._dec(1000.0), 1030.0, 5, engine._Hist())
        self.assertEqual(q, "suspecte")
        self.assertIn("dérive horloge", motifs[0])

    def test_frozen_value_is_suspect(self):
        h = engine._Hist([100.0] * 5)
        q, motifs, _ = engine.classify(self._dec(1000.0), 1000.2, 5, h)
        self.assertIn("valeur figée", motifs)

    def test_zero_is_a_measure_not_absent(self):
        d = self._dec(1000.0)
        d["P"] = (0.0, "valide")
        q, _, _ = engine.classify(d, 1000.1, 5, engine._Hist())
        self.assertEqual(q, "valide")


class TestModbusTCP(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.srv = ModbusTCPServer("127.0.0.1", 15020).start()
        cls.srv.set_registers(1, {100: 7, 101: 8})

    def test_read(self):
        self.assertEqual(read_registers("127.0.0.1", 15020, 1, 100, 2), [7, 8])

    def test_offline_unit_times_out(self):
        self.srv.set_online(1, False)
        with self.assertRaises(OSError):
            read_registers("127.0.0.1", 15020, 1, 100, 2, timeout=0.3)
        self.srv.set_online(1, True)

    def test_illegal_address_exception(self):
        from modbus_tcp import ModbusError
        with self.assertRaises(ModbusError):
            read_registers("127.0.0.1", 15020, 1, 500, 2)


class TestEnergy(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        db.init()
        energy.ensure_baseline()

    def test_tarif_periods(self):
        t = {"pointe": [17, 22], "creuses": [22, 7]}
        self.assertEqual([energy.tarif_period(h, t) for h in (0, 6, 7, 16, 17, 21, 22, 23)],
                         ["creuses", "creuses", "pleines", "pleines", "pointe", "pointe", "creuses", "creuses"])

    def test_ols_recovers_known_model(self):
        xs = [[1, 2], [2, 1], [3, 5], [4, 3], [5, 8]]
        ys = [10 + 2 * a + 3 * b for a, b in xs]
        beta, r2, cv = energy.ols(xs, ys)
        for got, exp in zip(beta, [10, 2, 3]):
            self.assertAlmostEqual(got, exp, places=6)
        self.assertAlmostEqual(r2, 1.0, places=9)

    def test_ipe_formula(self):
        ipes = {i["code"]: i for i in energy.compute_ipe()}
        m = energy.last_complete_month()
        row = {r["mois"]: r for r in energy.monthly_table()}[m]
        s = next(x for x in ipes["IPE-01"]["serie"] if x["mois"] == m)
        self.assertAlmostEqual(s["valeur"], row["conteneurs"] / row["evp"], places=9)

    def test_no_double_counting(self):
        head = db.query_one("SELECT inclus_agregation FROM measurement_points WHERE role='tete'")
        self.assertEqual(head["inclus_agregation"], 0)

    def test_baseline_quality(self):
        s = energy.ser()
        self.assertGreaterEqual(s["active"]["r2"], 0.75)

    def test_backup_restore(self):
        path = db.backup()
        ok, counts = db.verify_backup(path)
        self.assertTrue(ok)
        self.assertEqual(counts["electrical_posts"], 6)


class TestAlertRules(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        db.init()
        cls.eng = engine.AlertEngine()

    def test_raise_then_end_with_history(self):
        ctx = {"post_id": 1, "equipement": "CPT-P1", "message": "test seuil"}
        self.eng.check("R04", 1, True, False, 105.0, ctx)
        a = db.query_one("SELECT * FROM alerts WHERE rule_code='R04' AND point_id=1 ORDER BY id DESC")
        self.assertEqual(a["etat"], "nouvelle")
        self.assertEqual(a["condition_active"], 1)
        self.eng.check("R04", 1, False, True, 80.0, ctx)
        a = db.query_one("SELECT * FROM alerts WHERE id=?", (a["id"],))
        self.assertEqual(a["condition_active"], 0)
        ev = [e["action"] for e in db.query("SELECT action FROM alert_events WHERE alert_id=? ORDER BY id", (a["id"],))]
        self.assertEqual(ev, ["DETECTION", "FIN_CONDITION"])

    def test_hysteresis_keeps_alert(self):
        ctx = {"post_id": 2, "equipement": "CPT-P2", "message": "hystérésis"}
        self.eng.check("R04", 2, True, False, 101.0, ctx)
        self.eng.check("R04", 2, False, False, 99.0, ctx)        # sous le seuil mais dans la bande d'hystérésis
        a = db.query_one("SELECT condition_active FROM alerts WHERE rule_code='R04' AND point_id=2 ORDER BY id DESC")
        self.assertEqual(a["condition_active"], 1)

    def test_no_duplicate_while_active(self):
        ctx = {"post_id": 3, "equipement": "CPT-P3", "message": "doublon"}
        for _ in range(5):
            self.eng.check("R06", 3, True, False, 340.0, ctx)
        n = db.query_one("SELECT COUNT(*) AS n FROM alerts WHERE rule_code='R06' AND point_id=3")["n"]
        self.assertEqual(n, 1)


if __name__ == "__main__":
    unittest.main()
