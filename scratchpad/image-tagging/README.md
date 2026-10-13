# Image tagging progress (resumable)

Working files for tagging asset_library images (PR #2). Thumbnails/sheets live outside the repo.

- `inventory.json`: 1,383 in-scope images (idx, kind, Shopify image id, url, width/height, product/source).
- `groups.json`: idx -> representative idx of visually identical pictures (dHash); copies inherit tags.
- `progress.json`: `pass1` setting per representative idx, `pass2` detail tags per representative idx, `notes`.
- `bin/`: scripts. Rebuild thumbs with `python3 -I bin/fetch.py 400 <dir>`; sheets with `bin/sheet.py r<page>`.
- `final.json`: every inventory row with its final tags (built by `bin/finalize.py`).
- `skipped.json`: images not inserted (diagrams, logos, AI-looking, non-electric, irrelevant) and why.
- DB state (done): the 108 pre-existing rows are tagged (shopify_image_id set). 652 new rows inserted
  (325 installed, 327 product_only) in 8 batches built by `bin/payload.py insert [start] [n]`, with
  ON CONFLICT (shopify_image_id) DO NOTHING. render/other/detail rows were deliberately NOT inserted
  (option b); their tags are still in `final.json` if they're wanted later. Table total: 760 rows.
