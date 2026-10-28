import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Branch, BranchInfo } from "@/bindings";

const ipc = vi.hoisted(() => ({
  loaded: {} as Record<string, string[]>,
  save: vi.fn(),
}));

vi.mock("@/platform/ipc", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/platform/ipc")>();
  return {
    ...real,
    isTauri: () => true,
    commands: {
      ...real.commands,
      vcsLogBranchesLoad: () => Promise.resolve({ status: "ok", data: ipc.loaded }),
      vcsLogBranchesSave: (repo: string, branches: string[]) => {
        ipc.save(repo, branches);
        return Promise.resolve({ status: "ok", data: null });
      },
      vcsLog: () => Promise.resolve({ status: "ok", data: [] }),
      vcsConfigGet: () => Promise.resolve({ status: "ok", data: null }),
    },
  };
});

import {
  emptyFilters,
  initLogBranchFilter,
  loadLogBranchMemory,
  repoWorkspaceKey,
  resolveLogBranches,
  setLogBranches,
  useGitLog,
} from "../logStore";
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

const head: BranchInfo = {
  head: "main",
  headCommit: "1",
  upstream: null,
  ahead: 0,
  behind: 0,
  operation: null,
};

/** A project and its repository, so every test gets its own workspace memory. */
function project(root: string, repo = root, branches: readonly Branch[] = [b("main", { current: true })]) {
  useVcs.setState({
    root,
    roots: [repo],
    repo,
    branches: [...branches],
    branchesLoaded: true,
    branch: { ...head, head: branches.find((x) => x.current)?.name ?? null },
  });
  useGitLog.setState({ filters: emptyFilters(), branchScope: null, shownLog: "log", commits: [] });
}

beforeEach(() => {
  ipc.loaded = {};
  ipc.save.mockReset();
});

describe("resolveLogBranches", () => {
  it("defaults to the current branch when nothing was remembered", () => {
    expect(resolveLogBranches(undefined, ["main", "feature"], "main")).toEqual(["main"]);
  });

  it("defaults to HEAD when HEAD is detached", () => {
    expect(resolveLogBranches(undefined, ["main"], null)).toEqual(["HEAD"]);
  });

  it("keeps a remembered local branch", () => {
    expect(resolveLogBranches(["feature"], ["main", "feature"], "main")).toEqual(["feature"]);
  });

  it("keeps a remembered remote branch", () => {
    expect(resolveLogBranches(["origin/elasticsearch"], ["main", "origin/elasticsearch"], "main")).toEqual([
      "origin/elasticsearch",
    ]);
  });

  it("falls back to the current branch when the remembered one is gone", () => {
    expect(resolveLogBranches(["deleted"], ["main", "feature"], "main")).toEqual(["main"]);
  });

  it("keeps the remembered branches that still exist", () => {
    expect(resolveLogBranches(["deleted", "feature"], ["main", "feature"], "main")).toEqual(["feature"]);
  });

  it("keeps an empty list as all branches", () => {
    expect(resolveLogBranches([], ["main", "feature"], "main")).toEqual([]);
  });

  it("keeps HEAD", () => {
    expect(resolveLogBranches(["HEAD"], ["main"], "main")).toEqual(["HEAD"]);
  });
});

describe("repoWorkspaceKey", () => {
  it("names the project's own repository $PROJECT_DIR$", () => {
    expect(repoWorkspaceKey("/work/shop", "/work/shop")).toBe("$PROJECT_DIR$");
  });

  it("names a nested repository by its path below the project", () => {
    expect(repoWorkspaceKey("/work/shop", "/work/shop/backend")).toBe("$PROJECT_DIR$/backend");
  });

  it("falls back to the absolute path for a repository outside the project", () => {
    expect(repoWorkspaceKey("/work/shop", "/elsewhere/repo")).toBe("/elsewhere/repo");
  });
});

describe("Git Log branch filter memory", () => {
  it("selects the current branch on first open", async () => {
    project("/mem-first");
    await loadLogBranchMemory();

    expect(initLogBranchFilter()).toBe(true);
    expect(useGitLog.getState().filters.branches).toEqual(["main"]);
    expect(useGitLog.getState().branchScope).toBe("$PROJECT_DIR$");
  });

  it("uses the branch list's current flag before the branch info arrives", async () => {
    useVcs.setState({
      root: "/mem-race",
      roots: ["/mem-race"],
      repo: "/mem-race",
      branches: [b("main", { current: true })],
      branchesLoaded: true,
      branch: null,
    });
    useGitLog.setState({ filters: emptyFilters(), branchScope: null, shownLog: "log", commits: [] });
    await loadLogBranchMemory();

    initLogBranchFilter();
    expect(useGitLog.getState().filters.branches).toEqual(["main"]);
  });

  it("restores the remembered remote branch", async () => {
    ipc.loaded = { $PROJECT_DIR$: ["origin/elasticsearch"] };
    project("/mem-restore", "/mem-restore", [
      b("main", { current: true }),
      b("origin/elasticsearch", { remote: true }),
    ]);
    await loadLogBranchMemory();

    initLogBranchFilter();
    expect(useGitLog.getState().filters.branches).toEqual(["origin/elasticsearch"]);
  });

  it("falls back to the current branch when the remembered one was deleted", async () => {
    ipc.loaded = { $PROJECT_DIR$: ["deleted"] };
    project("/mem-deleted");
    await loadLogBranchMemory();

    initLogBranchFilter();
    expect(useGitLog.getState().filters.branches).toEqual(["main"]);
  });

  it("remembers a manually selected branch for the repository", async () => {
    project("/mem-save");
    await loadLogBranchMemory();

    setLogBranches(["feature"]);

    expect(useGitLog.getState().filters.branches).toEqual(["feature"]);
    await vi.waitFor(() => expect(ipc.save).toHaveBeenCalledWith("$PROJECT_DIR$", ["feature"]));
  });

  it("remembers clearing the filter as all branches", async () => {
    ipc.loaded = { $PROJECT_DIR$: ["feature"] };
    project("/mem-clear");
    await loadLogBranchMemory();
    initLogBranchFilter();

    setLogBranches([]);

    expect(useGitLog.getState().filters.branches).toEqual([]);
    await vi.waitFor(() => expect(ipc.save).toHaveBeenCalledWith("$PROJECT_DIR$", []));
  });

  it("keeps a separate selection for every repository", async () => {
    ipc.loaded = { $PROJECT_DIR$: ["main"], "$PROJECT_DIR$/backend": ["dev"] };
    project("/mem-multi", "/mem-multi/backend", [b("dev", { current: true }), b("main")]);
    await loadLogBranchMemory();

    initLogBranchFilter();
    expect(useGitLog.getState().filters.branches).toEqual(["dev"]);
    expect(useGitLog.getState().branchScope).toBe("$PROJECT_DIR$/backend");
  });
});
