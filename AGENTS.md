# Bot semantic routing

- User requirement: do not add keyword lists, substring matching, or regexes to decide natural-language intent, context retrieval, or historical-image relevance. Let the model judge the complete current request with bounded history, sender ownership, and candidate evidence.
- A historical message/image is a candidate, never a current attachment. Respect an empty model selection; invalid output or timeout must not force the latest image or the asker's image into the answer.
- Explicit quoted message IDs, protocol/URL parsing, permissions, resource limits, and documented command syntax may use deterministic rules. These are not semantic intent inference.
- Preserve official QQ and NapCat support. Create a branch before changes; validate and deploy authorized fixes before merging to main.
