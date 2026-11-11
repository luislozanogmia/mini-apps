const { test } = require('node:test');
const assert = require('node:assert/strict');
const { allowsLocalRequest } = require('../lib/local-access');

test('local browser and CLI requests remain allowed', () => {
  for (const host of ['127.0.0.1:8420','localhost:8420']) {
    assert.equal(allowsLocalRequest({headers:{host}},8420), true);
    assert.equal(allowsLocalRequest({headers:{host,origin:`http://${host}`,'sec-fetch-site':'same-origin'}},8420), true);
  }
});

test('reject remote origins, rebinding hosts, opaque origins and cross-site requests', () => {
  for (const headers of [
    {host:'attacker.example:8420'},
    {host:'127.0.0.1:8420',origin:'https://attacker.example'},
    {host:'127.0.0.1:8420',origin:'null'},
    {host:'127.0.0.1:8420','sec-fetch-site':'cross-site'},
    {host:'127.0.0.1:8420','sec-fetch-site':'same-site'},
    {host:'127.0.0.1:8420',origin:'http://127.0.0.1:8421'},
    {host:'127.0.0.1:8420',origin:'http://127.0.0.1:8420.attacker.example'},
    {}
  ]) assert.equal(allowsLocalRequest({headers},8420), false);
});
