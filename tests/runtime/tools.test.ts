// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import {
  benchAuthoringTools,
  benchCodingTools,
  benchReadOnlyTools,
  makeJsonOutputTool,
} from "../../src/runtime/tools.js";

const TMP = import.meta.dirname ?? ".";

describe("benchReadOnlyTools", () => {
  it("returns the read-only core tools (read/grep/find/ls) for the given cwd", () => {
    const names = benchReadOnlyTools(TMP).map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["read", "grep", "find", "ls"]));
    // mutating tools must NOT be present in the read-only set
    expect(names).not.toContain("bash");
    expect(names).not.toContain("edit");
    expect(names).not.toContain("write");
  });
});

describe("benchAuthoringTools", () => {
  it("returns read-only core tools (read/grep/find/ls) + bash for JSONL parsing (§4.18)", () => {
    const names = benchAuthoringTools(TMP).map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["read", "grep", "find", "ls", "bash"]));
    // the authoring agent must NOT get edit/write (it only reads + writes the manifest)
    expect(names).not.toContain("edit");
    expect(names).not.toContain("write");
  });
});

describe("benchCodingTools", () => {
  it("returns pi's coding tool set (bash/edit/read/write) for the given cwd", () => {
    // pi partitions tools: createCodingTools = {bash,edit,read,write}; createReadOnlyTools
    // = {find,grep,ls,read}. A stage needing both sets combines them at its call site.
    const names = benchCodingTools(TMP).map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["bash", "edit", "read", "write"]));
  });
});

describe("makeJsonOutputTool", () => {
  it("builds a valid AgentTool (name/description/parameters/execute)", () => {
    const schema = Type.Object({ value: Type.Integer() });
    const tool = makeJsonOutputTool("write_thing", "Emit the thing as JSON.", schema);
    expect(tool.name).toBe("write_thing");
    expect(tool.description).toBe("Emit the thing as JSON.");
    expect(tool.label).toBe("write_thing");
    expect(tool.parameters).toBe(schema);
    expect(typeof tool.execute).toBe("function");
  });

  it("execute validates params against the schema, accumulates the emitted JSON, and acks the agent", async () => {
    const schema = Type.Object({ value: Type.Integer() });
    const tool = makeJsonOutputTool("write_thing", "Emit the thing as JSON.", schema);
    const result = await tool.execute("call-1", { value: 7 } as unknown as Parameters<typeof tool.execute>[1]);
    expect(result.content).toEqual([{ type: "text", text: expect.stringMatching(/recorded|captured|done/i) }]);
    expect(tool._captured).toEqual([{ value: 7 }]);
  });

  it("_captured returns a defensive copy — mutating it does not corrupt internal state", async () => {
    const schema = Type.Object({ value: Type.Integer() });
    const tool = makeJsonOutputTool("write_thing", "Emit the thing as JSON.", schema);
    await tool.execute("call-1", { value: 7 } as unknown as Parameters<typeof tool.execute>[1]);
    const view = tool._captured;
    expect(view).toHaveLength(1);
    // mutate the returned array — the internal accumulator must be unaffected
    view.push({ value: 999 });
    expect(tool._captured).toHaveLength(1);
  });

  it("execute rejects params that fail schema validation (does not accumulate)", async () => {
    const schema = Type.Object({ value: Type.Integer() });
    const tool = makeJsonOutputTool("write_thing", "Emit the thing as JSON.", schema);
    const result = await tool.execute("call-1", { value: "not-an-int" } as unknown as Parameters<
      typeof tool.execute
    >[1]);
    // rejection surfaces as an error text result; nothing accumulated
    expect(tool._captured).toEqual([]);
    expect(result.content[0]).toMatchObject({ type: "text" });
  });
});
