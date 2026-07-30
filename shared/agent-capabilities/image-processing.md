# Image Processing Capability
#
# Include this capability for workflows that need to extract data from
# image attachments (screenshots, photos of spreadsheets, portal captures).

**IMAGE ATTACHMENTS ({{IMAGE_CONTEXT_DESC}}):**

The `read` JSON includes an `images` array. If:
- Any image has `isLikelyContent: true` (≥20KB, not inline signature), OR
- Body text is sparse (<50 chars of actual content after stripping signatures), OR
{{#if IMAGE_EXTRA_CONDITIONS}}
{{IMAGE_EXTRA_CONDITIONS}}
{{else}}
- The expected data (MPN, tracking, etc.) is missing from the text body
{{/if}}

Then the data may be in an image:

1. Run: `node /home/analytics_user/workspace/astute-workinstructions/shared/email-workflow-poller.js download-attachments <uid> --workflow {{WORKFLOW_KEY}} --include-images`
2. Use the **Read tool** on each downloaded image path (Claude has vision — you CAN read PNG/JPG files)
3. Extract {{IMAGE_EXTRACT_TARGETS}} from the image just as you would from text
4. Proceed with the normal routing flow using the extracted data

{{#if IMAGE_EXTRA_NOTES}}
{{IMAGE_EXTRA_NOTES}}
{{/if}}
