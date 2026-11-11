'use strict';

// Keep the local terminal service unreachable from unrelated browser origins.
function allowsLocalRequest(req, port) {
  const host = req.headers.host;
  if (![`127.0.0.1:${port}`, `localhost:${port}`].includes(host)) return false;
  const origin = req.headers.origin;
  if (origin !== undefined && origin !== `http://${host}`) return false;
  const site = req.headers['sec-fetch-site'];
  return !site || site === 'same-origin' || site === 'none';
}

module.exports = { allowsLocalRequest };
