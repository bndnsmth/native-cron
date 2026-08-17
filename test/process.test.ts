import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { decodeProcessOutput } from "../src/process";

test("decodes UTF-8 and Windows UTF-16 process output", () => {
  assert.equal(decodeProcessOutput(Buffer.from("hello", "utf8")), "hello");
  assert.equal(
    decodeProcessOutput(
      Buffer.concat([
        Buffer.from([0xff, 0xfe]),
        Buffer.from("<Enabled>false</Enabled>", "utf16le"),
      ]),
    ),
    "<Enabled>false</Enabled>",
  );
  assert.equal(
    decodeProcessOutput(Buffer.from("<Enabled>false</Enabled>", "utf16le")),
    "<Enabled>false</Enabled>",
  );
});
