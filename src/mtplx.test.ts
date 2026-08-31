import {
  busyRequestCount,
  localServePort,
  mtplxLogPath,
  mtplxServeArgs,
  parseMtplxPacks,
  resolveMtplxPack,
} from "./mtplx";

describe("parseMtplxPacks", () => {
  // The shape `mtplx models --json` actually returns, trimmed to the fields carl
  // reads. A rename upstream should break here rather than leave carl believing
  // the machine has no local models at all.
  test("reads mtplx's cache listing", () => {
    expect(
      parseMtplxPacks({
        cache_dir: "/Users/me/.mtplx/models",
        models: [
          {
            repo_id: "Youssofal/Qwen3.5-9B-MTPLX-Optimized-Speed",
            path: "/Users/me/.mtplx/models/Youssofal--Qwen3.5-9B-MTPLX-Optimized-Speed",
            size_gb: 8.695,
            validation: { ok: true, missing_files: [] },
          },
          {
            repo_id: "Youssofal/Qwen3.8-27B-MTPLX-Optimized-Speed",
            path: "/Users/me/.mtplx/models/Youssofal--Qwen3.8-27B-MTPLX-Optimized-Speed",
            validation: { ok: true },
          },
        ],
      }),
    ).toEqual([
      {
        repoId: "Youssofal/Qwen3.5-9B-MTPLX-Optimized-Speed",
        path: "/Users/me/.mtplx/models/Youssofal--Qwen3.5-9B-MTPLX-Optimized-Speed",
      },
      {
        repoId: "Youssofal/Qwen3.8-27B-MTPLX-Optimized-Speed",
        path: "/Users/me/.mtplx/models/Youssofal--Qwen3.8-27B-MTPLX-Optimized-Speed",
      },
    ]);
  });

  test("skips a pack mtplx reports as unservable", () => {
    expect(
      parseMtplxPacks({
        models: [
          { repo_id: "half/downloaded", validation: { ok: false } },
          { repo_id: "whole/pack", validation: { ok: true } },
        ],
      }),
    ).toEqual([{ repoId: "whole/pack", path: "" }]);
  });

  test("keeps a pack that discloses no validation", () => {
    // Absent is not failed: an upstream field rename should cost carl the check,
    // not the model.
    expect(parseMtplxPacks({ models: [{ repo_id: "a/b" }] })).toEqual([
      { repoId: "a/b", path: "" },
    ]);
  });

  test("reads nothing from a body with no models array", () => {
    expect(parseMtplxPacks({ error: "no cache" })).toEqual([]);
    expect(parseMtplxPacks(undefined)).toEqual([]);
  });

  test("skips entries with no usable repo id", () => {
    expect(
      parseMtplxPacks({ models: [{ repo_id: "" }, null, { repo_id: "a/b" }] }),
    ).toEqual([{ repoId: "a/b", path: "" }]);
  });
});

describe("resolveMtplxPack", () => {
  const packs = [
    { repoId: "Youssofal/Qwen3.5-9B-MTPLX-Optimized-Speed", path: "/c/9b" },
    { repoId: "Youssofal/Qwen3.8-27B-MTPLX-Optimized-Speed", path: "/c/27b" },
  ];

  test("resolves the config's spelling of the model", () => {
    // What ~/.config/carl/config.json actually says, against what mtplx calls
    // the same model.
    expect(resolveMtplxPack("qwen38-27b", packs)).toBe(packs[1]);
    expect(resolveMtplxPack("qwen35-9b", packs)).toBe(packs[0]);
  });

  test("resolves the server's spelling too, so a start is idempotent", () => {
    expect(resolveMtplxPack("mtplx-qwen35-9b-optimized-speed", packs)).toBe(
      packs[0],
    );
  });

  test("resolves the repo id itself", () => {
    expect(
      resolveMtplxPack("Youssofal/Qwen3.8-27B-MTPLX-Optimized-Speed", packs),
    ).toBe(packs[1]);
  });

  test("answers nothing for a model this machine has not cached", () => {
    expect(resolveMtplxPack("sonnet4.6", packs)).toBeUndefined();
    expect(resolveMtplxPack("qwen38-27b", [])).toBeUndefined();
  });

  // A 20GB load is too expensive to guess at, and the wrong model would report
  // itself as the right one for the rest of the run.
  test("refuses a name that fits several packs", () => {
    expect(() => resolveMtplxPack("qwen", packs)).toThrow(
      /matches more than one model/,
    );
    expect(() => resolveMtplxPack("qwen", packs)).toThrow(/Qwen3.8-27B/);
  });
});

describe("busyRequestCount", () => {
  // The two counts mtplx's /health reports, and the reason carl reads both: a
  // server that is working on a request must never be read as idle, because
  // stopping it fails that request with a transport error.
  test("reads an idle server as idle", () => {
    expect(
      busyRequestCount({
        active_requests: 0,
        scheduler: { active_requests: 0 },
      }),
    ).toBe(0);
  });

  test("takes the larger of the two counts", () => {
    expect(
      busyRequestCount({
        active_requests: 0,
        scheduler: { active_requests: 1 },
      }),
    ).toBe(1);
    expect(
      busyRequestCount({
        active_requests: 2,
        scheduler: { active_requests: 0 },
      }),
    ).toBe(2);
  });

  test("reads either count on its own", () => {
    expect(busyRequestCount({ active_requests: 1 })).toBe(1);
    expect(busyRequestCount({ scheduler: { active_requests: 3 } })).toBe(3);
  });

  test("answers nothing for a body that reports no count", () => {
    expect(busyRequestCount({ ok: true })).toBeUndefined();
    expect(busyRequestCount(undefined)).toBeUndefined();
    expect(busyRequestCount({ active_requests: "one" })).toBeUndefined();
  });
});

describe("localServePort", () => {
  test("takes the port carl expects the server on", () => {
    expect(localServePort("http://localhost:8000/v1")).toBe(8000);
    expect(localServePort("http://127.0.0.1:9001/v1")).toBe(9001);
  });

  test("falls back to the scheme's port when the endpoint names none", () => {
    expect(localServePort("http://localhost/v1")).toBe(80);
    expect(localServePort("https://localhost/v1")).toBe(443);
  });

  // carl starts only servers it could also stop, and a remote endpoint is
  // someone else's to run.
  test("refuses an endpoint on another host", () => {
    expect(localServePort("http://gpu.lan:8000/v1")).toBeUndefined();
  });

  test("refuses an endpoint it cannot parse", () => {
    expect(localServePort("not a url")).toBeUndefined();
  });
});

describe("mtplxServeArgs", () => {
  test("serves one named model on loopback with no credential", () => {
    expect(
      mtplxServeArgs("Youssofal/Qwen3.5-9B-MTPLX-Optimized-Speed", 8000),
    ).toEqual([
      "serve",
      "--model",
      "Youssofal/Qwen3.5-9B-MTPLX-Optimized-Speed",
      "--host",
      "127.0.0.1",
      "--port",
      "8000",
      "--no-auth",
      "--yes",
    ]);
  });

  test("never asks mtplx to confirm anything interactively", () => {
    // carl's stdin belongs to the skill run; a prompt here would hang it.
    expect(mtplxServeArgs("a/b", 8000)).toContain("--yes");
  });

  test("leaves the runtime profile to mtplx", () => {
    // mtplx resolves the profile per model, and overriding it from here would
    // silently change what a run measures.
    expect(mtplxServeArgs("a/b", 8000)).not.toContain("--profile");
  });
});

describe("mtplxLogPath", () => {
  test("logs per port, under carl's own config directory", () => {
    const previous = process.env.HOME;
    process.env.HOME = "/home/user";
    try {
      expect(mtplxLogPath(8000)).toBe(
        "/home/user/.config/carl/logs/mtplx-8000.log",
      );
    } finally {
      process.env.HOME = previous;
    }
  });
});
