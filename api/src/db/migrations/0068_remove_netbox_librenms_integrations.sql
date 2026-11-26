-- The NetBox and LibreNMS integrations were removed (Rackpath replaces
-- NetBox; LibreNMS is no longer used). Delete any configured instances of
-- them. Devices they imported are kept: devices.source_integration_id is
-- set to NULL by its foreign key, and their sync history is removed with
-- them (integration_sync_log cascades).
DELETE FROM project_integrations WHERE platform IN ('netbox', 'librenms');
