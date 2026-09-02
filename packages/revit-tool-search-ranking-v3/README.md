# Revit tool-search ranking contract v3

This package is the language-neutral behavioral contract for deterministic
Revit capability search. The native add-in and MCP process execute equivalent
implementations because they run in different language runtimes; both are
bound to the exact scores and ordering invariants in `golden-vectors.json`.

The v3 contract:

- normalizes Unicode with NFKC and splits camelCase, PascalCase, digits,
  underscores, and hyphens before semantic aliasing;
- scores each query token once at its highest-authority field, so repeated prose
  and large reflection-derived schemas cannot buy relevance;
- gives an explicit bonus only to domain task verbs present in a path or title;
- rewards ordered domain phrases in paths and titles;
- ignores request-schema field arrays for relevance;
- ranks equal scores by lower declared route risk and then ordinal path;
- uses only `method`, `path`, `risk`, `group`, `title`, `description`, and
  `example` as the shared search document; and
- publishes `operator.tool_search_ranking.v3` with every new search result.

Adding a new independent ranking implementation or changing any score requires
updating this versioned contract and proving the same golden vectors in both
the TypeScript and C# test suites.
