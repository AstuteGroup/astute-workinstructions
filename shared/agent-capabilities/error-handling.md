# Transient Error Handling Capability
#
# Standard error handling for batch processing - continue on single-message failures.

If a single message hits a transient error ({{ERROR_EXAMPLES}}), log the error in your output and continue with the next message. Do not abort the batch on per-message failure.
