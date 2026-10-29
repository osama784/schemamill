--
-- PostgreSQL database dump (extensions target)
--

CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA hs1;

CREATE EXTENSION IF NOT EXISTS hstore WITH SCHEMA hs2;

CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA public;

CREATE EXTENSION IF NOT EXISTS btree_gist WITH SCHEMA public;

COMMENT ON EXTENSION pgcrypto IS 'crypto v2';

COMMENT ON EXTENSION hstore IS 'key-value store';

COMMENT ON EXTENSION btree_gist IS 'GiST index support';
