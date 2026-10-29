--
-- PostgreSQL database dump (extensions baseline)
--

CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA hs1;

CREATE EXTENSION IF NOT EXISTS hstore WITH SCHEMA hs1;

CREATE EXTENSION IF NOT EXISTS citext WITH SCHEMA public;

CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA public;

COMMENT ON EXTENSION pgcrypto IS 'crypto v1';

COMMENT ON EXTENSION hstore IS 'key-value store';

COMMENT ON EXTENSION citext IS 'case-insensitive text';

COMMENT ON EXTENSION "uuid-ossp" IS 'uuid generators';
