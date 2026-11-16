# Builds a standalone UCI binary, as OpenBench does: make EXE=name
#
# Reproducible: the same engine.ts, Bun version and EXE give a
# byte-identical binary (Bun embeds its own runtime), so the build
# refuses any Bun but BUN_VERSION.

EXE ?= pedagog
BUN ?= bun
BUN_VERSION := 1.4.2

.PHONY: all check-bun clean

all: check-bun
	$(BUN) build --compile engine.ts --outfile $(EXE)

check-bun:
	@v="$$($(BUN) --version)"; [ "$$v" = "$(BUN_VERSION)" ] || \
	  { echo "need Bun $(BUN_VERSION), found $$v" >&2; exit 1; }

clean:
	rm -f $(EXE) $(EXE).exe