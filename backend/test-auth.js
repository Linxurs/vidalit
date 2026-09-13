// Test de la capa de autenticacion por x-api-key (audit v2 finding #2).
const assert = require('assert');
const { makeRequireAuth } = require('./auth');

let results = [];
const R = (name, fn) => { try { fn(); results.push(true); console.log(`PASS  ${name}`); } catch (e) { results.push(false); console.log(`FAIL  ${name}: ${e.message}`); } };

// Desactivada (sin clave): todos pasan.
const open = makeRequireAuth(null);
const ok = { status: () => ({ json: () => {} }) };
R('sin clave configurada: requiereAuth no bloquea', () => {
  let passed = false;
  open({ get: () => null }, { status: () => ({ json: () => { throw new Error('no debe responder 401'); } }) }, () => { passed = true; });
  assert.ok(passed);
});

// Activada con clave.
const auth = makeRequireAuth('secret123');
R('clave correcta: pasa al handler', () => {
  let passed = false;
  const req = { get: (h) => (h === 'x-api-key' ? 'secret123' : null) };
  const next = () => { passed = true; };
  auth(req, ok, next);
  assert.ok(passed);
});

R('sin header x-api-key: responde 401', () => {
  let status = 0, body = null;
  const req = { get: () => null };
  const res = { status: (s) => ({ json: (b) => { status = s; body = b; } }) };
  auth(req, res, () => { throw new Error('no debe pasar'); });
  assert.strictEqual(status, 401);
  assert.deepStrictEqual(body, { ok: false, error: 'unauthorized' });
});

R('clave incorrecta: responde 401', () => {
  let status = 0;
  const req = { get: () => 'wrong' };
  const res = { status: (s) => ({ json: () => { status = s; } }) };
  auth(req, res, () => { throw new Error('no debe pasar'); });
  assert.strictEqual(status, 401);
});

const fails = results.filter(ok => !ok).length;
console.log(`\n${results.length - fails}/${results.length} checks OK`);
process.exit(fails ? 1 : 0);