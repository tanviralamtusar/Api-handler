-- Add service_api_key column to user_configs for external API access
ALTER TABLE public.user_configs 
ADD COLUMN IF NOT EXISTS service_api_key text UNIQUE;

-- Create index for faster lookups
CREATE INDEX IF NOT EXISTS idx_user_configs_service_api_key ON public.user_configs(service_api_key);
