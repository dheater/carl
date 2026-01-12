# Portability

**Enforcement:** Not yet automated

**TODO:**
- Detect platform-specific code without guards (#ifdef, cfg!)
- Detect hardcoded paths (/usr/local, C:\, etc.)
- Detect endianness assumptions (direct struct casts)

**Will NOT enforce:**
- Compiler-specific extensions (sometimes necessary)

## Principle

Broad, boring compatibility. Target stable platform APIs. Use runtime feature detection for optional capabilities. Pin toolchains for reproducible builds. Test on oldest supported OS and latest variant per platform.

---

## Why

- **Maximize reach** - Run on wide range of systems
- **Reduce support burden** - Fewer platform-specific bugs
- **Stable APIs age well** - Avoid churn from unstable APIs
- **Reproducible builds** - Pinned toolchains prevent "works on my machine"

---

## Support Matrix

| Platform | Minimum Version | Architectures | Notes |
|----------|----------------|---------------|-------|
| **Linux** | glibc ≥ 2.28 | x86_64, arm64 | Build against old glibc for forward compat |
| **Windows** | Windows 10 22H2+ | x64, arm64 | Pin toolchain (MSVC or MinGW) |
| **macOS** | macOS 11 (Big Sur)+ | x86_64, arm64 | Avoid private/unstable APIs |

---

## Platform Guidelines

**Linux:** Build against old glibc (2.28). Validate: `readelf -V binary | grep GLIBC`. Test on minimal distro.

**Windows:** Pin toolchain (MSVC/MinGW version). Avoid private APIs, hardcoded paths.

**macOS:** Set `MACOSX_DEPLOYMENT_TARGET=11.0`. Avoid private frameworks, undocumented APIs.

---

## Linking Policy

| Dependency Type | Policy | Rationale |
|----------------|--------|-----------|
| **TLS/Crypto** | Dynamic link to system libs | Security updates, FIPS compliance |
| **UI** | Follow platform best practices | Platform-specific |
| **Other** | Follow dependency budget | See `carl/rules/dependencies.md` |

---

## Feature Detection

**Runtime detection:**
```zig
const has_avx2 = std.Target.x86.featureSetHas(cpu.features, .avx2);
if (has_avx2) processWithAVX2(data) else processGeneric(data);
```

**Capability reporting:**
```c
typedef struct LibCaps { uint32_t size; uint64_t features; } LibCaps;
int lib_get_capabilities(LibCaps* caps);
```

**Never repurpose semantics:** New behavior is opt-in via flags, not automatic under same API

---

## Build & Test

**Pin toolchains:** Document exact versions (Zig 0.13.0, LLVM 17.0.6)

**Reproducible builds:** Local caches (Nix/Zig/Artifactory). One-time fetch, then offline.

**CI matrix:** Test oldest + latest per platform (Linux, Windows, macOS) × (x86_64, arm64)

**Smoke tests:** `./binary --version`, publish dependency trees (`ldd`, `otool -L`, `dumpbin`)

---

## Checklist

- [ ] Builds on oldest OS, tested on latest?
- [ ] No private/unstable APIs?
- [ ] Toolchain pinned, offline build works?
- [ ] Feature detection for optional capabilities?
- [ ] Dependency tree published?

---

## Enforcement

**Automated:** `carl check-glibc-compat`, `carl check-offline-build`, `carl ci-matrix`

**Code review:** Platform-specific code justified? Feature detection used? Toolchain pinned?

---

## References

- `plans/portability-and-platform-stability.md`
- `carl/rules/dependencies.md`
- `carl/rules/api-stability.md`

