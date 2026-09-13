// Autenticacion por header x-api-key para las rutas de mutacion.
// Si ARBITRAGEX_API_KEY no esta definido, el servidor arranca sin clave
// (modo dev); con clave, TODA mutacion exige el header correcto o 401.
function makeRequireAuth(apiKey) {
  if (!apiKey) return (req, res, next) => next();
  return (req, res, next) => {
    if (req.get('x-api-key') === apiKey) return next();
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  };
}

module.exports = { makeRequireAuth };