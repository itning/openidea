import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import type { EditorInput } from "@/workbench/contributions";
import { iconMarkup } from "@/ui";

// A text side counts as file-backed, so the toolbar shows Jump to Source.
vi.mock("../diffInput", async (importOriginal) => {
  const real = await importOriginal<typeof import("../diffInput")>();
  return { ...real, sideFile: () => "/p/a.ts" };
});

import { DiffEditor } from "../DiffEditor";

const input = {
  kind: "diff",
  key: "diff:test",
  data: {
    path: "/p/a.ts",
    left: { type: "text", text: "a\n", label: "HEAD" },
    right: { type: "text", text: "b\n", label: "Working Copy" },
  },
} as unknown as EditorInput;

/** `d` attributes of an SVG, which is what tells two icons apart. */
const paths = (html: string) => [...html.matchAll(/ d="([^"]+)"/g)].map((m) => m[1]);

describe("Diff toolbar", () => {
  it("puts Jump to Source right after Next Difference, in the navigation group", () => {
    render(<DiffEditor input={input} />);
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

  it("shows a pencil for Jump to Source", () => {
    render(<DiffEditor input={input} />);
    const button = screen.getByRole("button", { name: "Jump to Source" });
    expect(paths(button.querySelector("svg")!.innerHTML)).toEqual(paths(iconMarkup("edit", 14)!));
  });
});
