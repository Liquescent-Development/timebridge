# Test Failures Documentation

## timeql-to-sql.test.ts

As of this commit, there are 19 pre-existing test failures in timeql-to-sql.test.ts that are NOT related to the pattern matching implementation.

### Root Cause
The SQLBuilder class does not implement selector parsing. The tests expect selectors like `{app="frontend", level="error"}` to be parsed into SQL conditions like `json_extract_string(labels, '$.app') = 'frontend'`, but the SQLBuilder only checks the `source` field and ignores selectors entirely.

### Affected Tests (19 failures)
1. Native Query Translation tests - expecting JSON extraction from selectors
2. Some temporal join tests - expecting proper time interval formatting
3. Multi-stream tests - expecting proper stream handling
4. Several other tests expecting features not implemented in SQLBuilder

### Pattern Matching Tests (6 passing)
All new pattern matching tests are passing:
- ✓ should generate SQL for "follows" pattern
- ✓ should generate SQL for "precedes" pattern  
- ✓ should generate SQL for "before" pattern
- ✓ should generate SQL for "after" pattern
- ✓ should handle temporal constraints
- ✓ should handle patterns without selectors

### Resolution
To fix these tests, the SQLBuilder class would need to be updated to:
1. Parse selector strings into label conditions
2. Generate appropriate JSON extraction SQL
3. Handle different selector operators (=, !=, =~, !~)

This is a significant refactor of existing code that is outside the scope of the pattern matching feature implementation.