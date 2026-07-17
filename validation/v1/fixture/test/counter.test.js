import assert from "node:assert/strict"
import test from "node:test"
import { next } from "../src/counter.js"

test("next increments by one", () => {
  assert.equal(next(1), 2)
})
