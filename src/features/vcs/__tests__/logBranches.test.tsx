import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { Branch, BranchInfo } from "@/bindings";

vi.mock("@/platform/ipc", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/platform/ipc")>();
  return {
    ...real,
    commands: {
      ...real.commands,
      vcsLog: () => Promise.resolve({ status: "ok", data: [] }),
      vcsConfigGet: () => Promise.resolve({ status: "ok", data: null }),
    },
  };
});

import { BranchesPanel } from "../GitLog";
import { emptyFilters, useGitLog } from "../logStore";
import { useVcs } from "../store";

const b = (name: string, opts: Partial<Branch> = {}): Branch => ({
  name,
  remote: false,
  current: false,
  upstream: null,
  ahead: 0,
  behind: 0,
  lastCommitMs: 0,
  commit: "",
  ...opts,
});

const branches = [b("main", { current: true, commit: "1" }), b("feature", { commit: "2" })];

const head: BranchInfo = {
  head: "main",
  headCommit: "1",
  upstream: null,
  ahead: 0,
  behind: 0,
  operation: null,
};

beforeEach(() => {
  useVcs.setState({ root: "/p", repo: "/p", branches, branchesLoaded: true, branch: head });
  useGitLog.setState({ filters: emptyFilters() });
});

describe("Git Log branches pane", () => {
  it("one click only selects the branch", () => {
    render(<BranchesPanel />);
    fireEvent.mouseDown(screen.getByText("feature"));
    expect(useGitLog.getState().filters.branches).toEqual([]);
    expect(screen.getByText("feature").closest("[data-row]")).toHaveAttribute("aria-selected", "true");
  });

  it("double click switches the log to that branch", () => {
    render(<BranchesPanel />);
    fireEvent.doubleClick(screen.getByText("feature"));
    expect(useGitLog.getState().filters.branches).toEqual(["feature"]);
  });

  it("double click on the current branch switches to its log too", () => {
    render(<BranchesPanel />);
    fireEvent.doubleClick(screen.getByText("main"));
    expect(useGitLog.getState().filters.branches).toEqual(["main"]);
  });

  it("double click on HEAD shows HEAD's log", () => {
    render(<BranchesPanel />);
    fireEvent.doubleClick(screen.getByText("HEAD (Current Branch)"));
    expect(useGitLog.getState().filters.branches).toEqual(["HEAD"]);
  });
});
