"""
modbus_tcp.py — Implémentation minimale du protocole Modbus TCP (sans dépendance).

- ModbusTCPServer : serveur multi-esclaves (Unit ID 1..N) qui simule les compteurs
  d'énergie des 6 postes. Fonctions supportées : 0x03 (Read Holding Registers)
  et 0x04 (Read Input Registers).
- read_registers() : client Modbus TCP (trame MBAP + PDU) utilisé par le service
  d'acquisition.

Trame Modbus TCP (ADU) = MBAP (7 octets) + PDU
  MBAP : Transaction ID (2) | Protocol ID = 0 (2) | Length (2) | Unit ID (1)
  PDU  : Function code (1) | Start address (2) | Quantity (2)
"""
import socket
import socketserver
import struct
import threading
import itertools

_tid = itertools.count(1)
_tid_lock = threading.Lock()


class ModbusError(Exception):
    pass


# --------------------------------------------------------------------------- #
#  Encodage / décodage des types usuels (big-endian, mot de poids fort d'abord)
# --------------------------------------------------------------------------- #
def float32_to_regs(v):
    hi, lo = struct.unpack(">HH", struct.pack(">f", float(v)))
    return [hi, lo]


def regs_to_float32(hi, lo):
    return struct.unpack(">f", struct.pack(">HH", hi, lo))[0]


def uint32_to_regs(v):
    v = int(v) & 0xFFFFFFFF
    return [(v >> 16) & 0xFFFF, v & 0xFFFF]


def regs_to_uint32(hi, lo):
    return (hi << 16) | lo


# --------------------------------------------------------------------------- #
#  Serveur (esclaves simulés)
# --------------------------------------------------------------------------- #
class _Handler(socketserver.BaseRequestHandler):
    def handle(self):
        sock = self.request
        sock.settimeout(5)
        srv = self.server.modbus
        while True:
            try:
                head = _recv_exact(sock, 7)
            except (OSError, ModbusError):
                return
            tid, pid, length, unit = struct.unpack(">HHHB", head)
            try:
                pdu = _recv_exact(sock, length - 1)
            except (OSError, ModbusError):
                return
            # Esclave hors ligne (incident simulé) : aucune réponse -> timeout client
            if not srv.is_online(unit):
                continue
            fc = pdu[0]
            if fc not in (3, 4) or len(pdu) < 5:
                resp = bytes([fc | 0x80, 0x01])  # Illegal function
            else:
                addr, qty = struct.unpack(">HH", pdu[1:5])
                regs = srv.read(unit, addr, qty)
                if regs is None:
                    resp = bytes([fc | 0x80, 0x02])  # Illegal data address
                else:
                    resp = bytes([fc, 2 * qty]) + struct.pack(">%dH" % qty, *regs)
            mbap = struct.pack(">HHHB", tid, 0, len(resp) + 1, unit)
            try:
                sock.sendall(mbap + resp)
            except OSError:
                return


class _TCPServer(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


class ModbusTCPServer:
    """Banque de registres par Unit ID, accessible en Modbus TCP."""

    def __init__(self, host="127.0.0.1", port=5020):
        self.host, self.port = host, port
        self._banks = {}          # unit -> {address: value}
        self._offline = set()     # units qui ne répondent plus
        self._lock = threading.Lock()
        self._srv = None

    def set_registers(self, unit, mapping):
        with self._lock:
            self._banks.setdefault(unit, {}).update(mapping)

    def set_online(self, unit, online=True):
        with self._lock:
            (self._offline.discard if online else self._offline.add)(unit)

    def is_online(self, unit):
        with self._lock:
            return unit in self._banks and unit not in self._offline

    def read(self, unit, addr, qty):
        if qty < 1 or qty > 125:
            return None
        with self._lock:
            bank = self._banks.get(unit, {})
            out = []
            for a in range(addr, addr + qty):
                if a not in bank:
                    return None
                out.append(bank[a])
            return out

    def start(self):
        self._srv = _TCPServer((self.host, self.port), _Handler)
        self._srv.modbus = self
        t = threading.Thread(target=self._srv.serve_forever, name="modbus-server", daemon=True)
        t.start()
        return self


# --------------------------------------------------------------------------- #
#  Client
# --------------------------------------------------------------------------- #
def _recv_exact(sock, n):
    buf = b""
    while len(buf) < n:
        chunk = sock.recv(n - len(buf))
        if not chunk:
            raise ModbusError("connexion fermée")
        buf += chunk
    return buf


def read_registers(host, port, unit, address, count, timeout=0.8, fc=3):
    """Lit `count` registres à partir de `address`. Lève ModbusError / socket.timeout."""
    with _tid_lock:
        tid = next(_tid) & 0xFFFF
    pdu = struct.pack(">BHH", fc, address, count)
    adu = struct.pack(">HHHB", tid, 0, len(pdu) + 1, unit) + pdu
    with socket.create_connection((host, port), timeout=timeout) as s:
        s.settimeout(timeout)
        s.sendall(adu)
        head = _recv_exact(s, 7)
        rtid, pid, length, runit = struct.unpack(">HHHB", head)
        body = _recv_exact(s, length - 1)
    if rtid != tid or runit != unit:
        raise ModbusError("réponse incohérente (TID/Unit)")
    if body[0] & 0x80:
        raise ModbusError("exception Modbus code %d" % body[1])
    nbytes = body[1]
    return list(struct.unpack(">%dH" % (nbytes // 2), body[2:2 + nbytes]))
