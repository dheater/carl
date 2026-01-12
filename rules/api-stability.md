# API Stability

**Enforcement:** Partial (`carl check_abi` counts symbols, does not detect breaking changes yet)

**TODO:**
- Detect breaking ABI changes (removed/changed functions)
- Detect opaque handle violations (exposed struct layouts)
- Detect missing size fields in option structs
- Detect unprefixed symbols (C/C++ only)
- Detect missing LIB_API visibility macros (C/C++ only)

## Principle

Runtime libraries export stable C ABIs with CalVer (`YYYY.MM.PATCH`). Never break ABI under the same name. New product. No SemVer v2, v3, etc. Evolve additively via capability negotiation. Incompatible redesigns ship as new products (e.g., `libX2`). Make breaking ABI hard but make a clean break (don't carry compatibily burden) when you do.

Think Catch -> Catch2, not Catch2 -> Catch2 v3

---

## Why

- **Stability is a feature** - Customers depend on unchanging APIs
- **Breaking changes break trust** - Forced upgrades create friction
- **Add-only evolution works** - New capabilities via feature bits, not versions
- **Rename forces clarity** - Incompatible redesigns are new products, not "v2"
- **Don't carry forward compatiblity/migration burden** Leave behind an LTS of the prior project and let users adopt the new over the next couple years.

---

## Public C API Design

### Symbol Naming
- Consistent prefix per library (e.g., `mylib_`, `app_`)
- Apply to all exported symbols, types, macros
- Use `LIB_API` visibility macro for exports

### Opaque Handles
```c
// ✅ DO: Opaque handle
typedef struct lib_ctx_* lib_ctx;

// ❌ DON'T: Expose struct layout
typedef struct { int fd; } lib_ctx;
```

### Size'd Option Structs
```c
typedef struct LibOpts {
    uint32_t size;        // sizeof(LibOpts) - caller sets
    uint32_t flags;
    uint32_t timeout_ms;
    uint32_t reserved[8]; // Future fields
} LibOpts;
```

### Capability Negotiation (No api_level)
```c
typedef struct LibCaps {
    uint32_t size;
    uint32_t flags;
    uint64_t features;    // Add-only bitset
    uint32_t max_frame_bytes;
    uint32_t reserved_u32[6];
    uint64_t reserved_u64[4];
} LibCaps;

#define LIB_CAP_SSH   (1ull<<0)
#define LIB_CAP_HTTP  (1ull<<1)
#define LIB_CAP_QUIC  (1ull<<2)

// Query capabilities
int lib_get_capabilities(LibCaps* caps);
```

### Error Model
```c
// Stable integer codes
typedef int32_t lib_err_t;
#define LIB_OK 0
#define LIB_ERR_NETWORK -1
#define LIB_ERR_AUTH -2

// Human-readable errors
const char* lib_strerror(lib_err_t code);
```

### Memory Ownership
```c
// Option 1: Library-provided free
void lib_free(void* ptr);

// Option 2: Two-call pattern (no owned pointers)
size_t lib_get_info_size(lib_ctx ctx);
int lib_get_info(lib_ctx ctx, char* buf, size_t len);
```

---

## Versioning Policy

| Aspect | Rule |
|--------|------|
| **Versioning** | CalVer: `YYYY.MM.PATCH` with `-beta.N` / `-rc.N` |
| **Breaking changes** | Never under same name; ship as new product |
| **Evolution** | Add-only: new APIs/options/fields |
| **Defaults** | Never change for existing APIs |
| **Deprecations** | Allowed with warnings; removal only in renamed product |
| **LTS** | 24-36 month maintenance window per chosen release |

---

## Enforcement

### ABI Compatibility Checks

**Linux (ELF):**
```bash
# Version script to control exports
abidiff old.so new.so \
  --headers-dir1 old/include \
  --headers-dir2 new/include
# Fail CI on incompatible changes
```

**macOS (Mach-O):**
```bash
# Exported symbols list
nm -g new.dylib | diff - expected_symbols.txt
```

**Windows:**
```bash
# .def file or decorated exports
# Avoid CRT allocations across boundary
```

### Header Surface Check
```bash
# Detect unintentional API changes
clang -Xclang -ast-dump=json public.h > api.json
diff api-baseline.json api.json
```

### CI Pipeline
1. Build last LTS + current HEAD
2. Run ABI diff tools (fail on breaks)
3. Header snapshot diff
4. Sanitizer builds (ASan/UBSan/TSan)
5. Fuzz targets (short CI; nightly long-run)

---

## Checklist: Before Changing Public API

- [ ] Is this add-only? (new function/field/flag)
- [ ] Are existing defaults unchanged?
- [ ] Are error codes stable?
- [ ] Is capability negotiation used (not api_level)?
- [ ] Incompatible change? → Ship as new product name
- [ ] Run: `abidiff` / symbol checks
- [ ] Update capability bits if adding features

---

## References

- `plans/native-c-api-stability-plan.md`
- `plans/dependencies-and-seams-charter.md`
- `carl/rules/subtract-first.md`

