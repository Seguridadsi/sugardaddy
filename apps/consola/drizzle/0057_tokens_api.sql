-- Tokens de la API pública de solo lectura y del MCP de control. Tabla nueva: una consola
-- anterior, si el nodo vuelve atrás, ni la lee ni la necesita.
CREATE TABLE "tokens_api" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"nombre" text NOT NULL,
	"hash" text NOT NULL,
	"prefijo" text NOT NULL,
	"alcance" jsonb DEFAULT '["read"]'::jsonb NOT NULL,
	"creador_oid" text NOT NULL,
	"creador_nombre" text NOT NULL,
	"creador_correo" text NOT NULL,
	"creado" timestamp with time zone DEFAULT now() NOT NULL,
	"caduca" timestamp with time zone,
	"ultimo_uso" timestamp with time zone,
	"revocado" timestamp with time zone,
	"revocado_por" text
);
--> statement-breakpoint
CREATE UNIQUE INDEX "tokens_api_hash" ON "tokens_api" USING btree ("hash");