# API Stability

**Enforcement:** Partial (`carl check_abi` counts symbols, does not detect breaking changes yet)

**TODO:**
- Detect breaking ABI changes (removed/changed functions)
- Detect opaque handle violations (exposed struct layouts)
- Detect missing size fields in option structs
- Detect unprefixed symbols (C/C++ only)
- Detect missing LIB_API visibility macros (C/C++ only)

## Principle

Runtime libraries export stable C ABIs with SemVer (`MAJOR.MINOR.PATCH`). Evolve additively via capability negotiation. Breaking changes allowed but rare (major version bump, clean break).

Applications may use CalVer (`YYYY.MM.PATCH`) - no public API to break.

## C API Patterns

**Symbol naming:** Consistent prefix (`mylib_`), `LIB_API` visibility macro

**Opaque handles:** `typedef struct lib_ctx_* lib_ctx;` (don't expose struct layout)

**Size'd structs:** Include `uint32_t size;` field, reserved fields for future

**Capability negotiation:** Feature bitset, not api_level

**Error model:** Stable integer codes + `lib_strerror()`

**Memory:** Library-provided `lib_free()` or two-call pattern (no owned pointers)

## Versioning

**Libraries:** SemVer `MAJOR.MINOR.PATCH` with `-beta.N` / `-rc.N`
- MAJOR: Breaking changes (rare, clean break)
- MINOR: New features (backward compatible)
- PATCH: Bug fixes

**Applications:** CalVer `YYYY.MM.PATCH` (no public API)

**Evolution:** Add-only (new APIs/options/fields). Never change defaults.

**Deprecations:** Warn first, remove in next major version

**LTS:** 24-36 months per major version

## Enforcement

**ABI checks:**
- Linux: `abidiff old.so new.so` (fail CI on breaks)
- macOS: `nm -g new.dylib | diff - expected_symbols.txt`
- Windows: `.def` file or decorated exports

**Header checks:** `clang -Xclang -ast-dump=json public.h` (diff against baseline)

**CI:** Build LTS + HEAD, run ABI diff, header diff, sanitizers, fuzz

## Checklist

- [ ] Add-only? (new function/field/flag)
- [ ] Defaults unchanged?
- [ ] Error codes stable?
- [ ] Capability negotiation used (not api_level)?
- [ ] Incompatible? → Bump major version (rare, clean break)
- [ ] Run: `abidiff` / symbol checks
- [ ] Update capability bits if adding features

