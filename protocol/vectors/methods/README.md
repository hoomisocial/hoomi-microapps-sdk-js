# Per-method conformance vectors

`protocol/vectors/codec/` pins the **envelope**. That was not enough: the
wallet payloads in this SDK and in the Dart host drifted into two mutually
incompatible shapes (`{amount, currency, orderId}` versus
`{amountMinor, currency, payeeRef}`) and every existing test still passed,
because no vector ever looked *inside* `params`.

These vectors pin the inside. Each file is one call against a host that
implements protocol v1, and both runners execute the same corpus:

- JS: `test/protocol/methods.test.ts` (against `MockHost`)
- Dart: the host repo's runner (against its own fake providers)

## Format

```jsonc
{
  "name": "wallet.requestPayment rejects a fractional amount",
  "protocol": 1,
  "method": "wallet.requestPayment",
  "params": { "amountMinor": 2500.5, "currency": "IDR", "payeeRef": "merchant:88" },
  "expect": { "ok": false, "errorCode": "E_INVALID_PARAMS" }
}
```

Fields:

| field | required | meaning |
| --- | --- | --- |
| `name` | yes | Human-readable description; used as the test name. |
| `protocol` | yes | Wire protocol version. Must equal the runner's `PROTOCOL_VERSION`. |
| `method` | yes | Method to invoke. |
| `params` | yes | Params object sent verbatim. |
| `setup` | no | Calls to make first (see below). |
| `expect.ok` | yes | Whether the call is expected to succeed. |
| `expect.result` | no | On success: **subset** match against the result object. Keys not listed are ignored. |
| `expect.resultTypes` | no | On success: `key → "string" \| "number" \| "boolean"`. For values a host is entitled to choose itself (ids), where pinning a literal would only pin *this* host's id scheme. |
| `expect.errorCode` | on failure | Exact wire error code. |
| `expect.errorData` | no | On failure: subset match against `error.data`. |

### `setup` and `$bindings`

Some methods need prior state (you cannot query a payment that was never
made). `setup` is an ordered list of calls executed before the vector's own
call; each entry may `bind` fields of its result to names:

```jsonc
"setup": [
  {
    "method": "wallet.requestPayment",
    "params": { "amountMinor": 1000, "currency": "IDR", "payeeRef": "merchant:88" },
    "bind": { "paymentId": "paymentId" }   // resultKey -> binding name
  }
],
"params": { "paymentId": "$paymentId" }    // a string of the form "$name" is substituted
```

Setup calls must succeed; a failing setup call fails the vector.
Substitution applies to string param values only, and only to values that are
exactly `"$name"` — there is no interpolation inside longer strings.

Every vector runs against a **fresh** host, so vectors never depend on each
other's ordering or on a shared balance.
