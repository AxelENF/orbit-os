-- Add durable worker lifecycle values in their own migration transaction.
-- PostgreSQL does not allow a newly-added enum value to be referenced by a
-- function created in the same transaction, so 0013 depends on this step.
alter type public.automation_job_status add value if not exists 'RETRY_WAIT';
alter type public.automation_job_status add value if not exists 'CANCELLED';
alter type public.automation_job_status add value if not exists 'DEAD_LETTER';
