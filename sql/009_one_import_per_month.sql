-- One import per month. R5 already refuses the same file twice (same
-- checksum). This also refuses a second, different file for a month that is
-- already loaded, such as a republished TLC file, which would otherwise put
-- every trip of that month into its partition twice.

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint
                   WHERE conname = 'import_batch_file_month_key') THEN
        ALTER TABLE import_batch
            ADD CONSTRAINT import_batch_file_month_key UNIQUE (file_month);
    END IF;
END
$$;

UPDATE validation_code
   SET description = 'File refused: same file or same month already imported'
 WHERE code = 'R5';
