@echo off
docker exec -i -e PGHOST=127.0.0.1 -e PGPORT=5432 -e PGUSER -e PGPASSWORD -e PGDATABASE %PG_DUMP_CONTAINER% pg_dump %*
