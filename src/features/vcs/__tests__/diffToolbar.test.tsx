import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import type { EditorInput } from "@/workbench/contributions";
import { iconMarkup } from "@/ui";

const probe = vi.fn();

vi.mock("@/platform/ipc", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/platform/ipc")>();
  return {
    ...real,
    commands: {
      ...real.commands,
      fsProbe: (path: string) => probe(path),
      vcsFileAt: () => Promise.resolve({ status: "ok", data: "a\n" }),
    },
  };
});

import { DiffEditor } from "../DiffEditor";

/** Git Log opens a commit's file: both sides are revisions. */
const input = {
  kind: "diff",
  key: "diff:test",
  data: {
    path: "/p/a.ts",
    left: { type: "rev", rev: "HEAD" },
    right: { type: "rev", rev: "abc123" },
  },
} as unknown as EditorInput;

/** `d` attributes of an SVG, which is what tells two icons apart. */
const paths = (html: string) => [...html.matchAll(/ d="([^"]+)"/g)].map((m) => m[1]);

beforeEach(() => {
  probe.mockReset();
  probe.mockResolvedValue({ status: "ok", data: { size: 3, binary: false, tooLarge: false } });
});

describe("Diff toolbar", () => {
  it("puts Jump to Source right after Next Difference, in the navigation group", async () => {
    render(<DiffEditor input={input} />);
    await screen.findByRole("button", { name: "Jump to Source" });
    const toolbar = screen.getByRole("toolbar", { name: "Diff" });
    const buttons = within(toolbar).getAllByRole("button");
    expect(buttons.slice(0, 3).map((b) => b.getAttribute("aria-label"))).toEqual([
      "Previous Difference",
      "Next Difference",
      "Jump to Source",
    ]);
    // One group: no separator between the three, one after them.
    expect(buttons[1]!.nextElementSibling).toBe(buttons[2]);
    expect(buttons[2]!.nextElementSibling).not.toBe(buttons[3]);
  });

  it("shows a pencil for Jump to Source", async () => {
    render(<DiffEditor input={input} />);
    const button = await screen.findByRole("button", { name: "Jump to Source" });
    expect(paths(button.querySelector("svg")!.innerHTML)).toEqual(paths(iconMarkup("edit", 14)!));
  });

  it("jumps to the working copy of a file shown at a revision", async () => {
    render(<DiffEditor input={input} />);
    await screen.findByRole("button", { name: "Jump to Source" });
    expect(probe).toHaveBeenCalledWith("/p/a.ts");
  });

  it("has no Jump to Source when the file is gone from the working tree", async () => {
    probe.mockRejectedValue(new Error("no such file"));
    render(<DiffEditor input={input} />);
    await waitFor(() => expect(probe).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByRole("button", { name: "Jump to Source" })).toBeNull());
  });
});
