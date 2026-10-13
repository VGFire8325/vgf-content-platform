# Image-tagging archive

`final.json` is the full output of the manual visual tagging of 1,383 Shopify images, done for
VGFire8325/vgf-content-platform#2. Each row has the Shopify image id, URL, width and height, and
its tags: setting, room, mounting, style, colors, quality, featured_ok, alt_text and confidence.

Only installed and product_only rows were inserted into `asset_library`. The render, other,
detail and diagram tags are kept here in case they're needed later.
The scripts and progress files are in the PR branch history, at commit b764ebd, under
`scratchpad/image-tagging/`.
