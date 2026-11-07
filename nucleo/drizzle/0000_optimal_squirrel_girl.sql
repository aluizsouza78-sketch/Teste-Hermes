CREATE TABLE "aprovacoes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"demanda_id" uuid NOT NULL,
	"tipo" text NOT NULL,
	"status" text DEFAULT 'pendente' NOT NULL,
	"detalhes" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"comentario" text,
	"decidido_em" timestamp with time zone,
	CONSTRAINT "aprovacoes_tipo_ck" CHECK ("aprovacoes"."tipo" in ('escopo','entrega','escalada','acao')),
	CONSTRAINT "aprovacoes_status_ck" CHECK ("aprovacoes"."status" in ('pendente','aprovada','recusada'))
);
--> statement-breakpoint
CREATE TABLE "auditoria" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"ator" text NOT NULL,
	"acao" text NOT NULL,
	"alvo_tipo" text NOT NULL,
	"alvo_id" uuid,
	"detalhes" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"credencial_ref" text
);
--> statement-breakpoint
CREATE TABLE "canais_cliente" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"cliente_id" uuid NOT NULL,
	"tipo" text NOT NULL,
	"identificador" text NOT NULL,
	CONSTRAINT "canais_cliente_tipo_identificador_uq" UNIQUE("tipo","identificador"),
	CONSTRAINT "canais_cliente_tipo_ck" CHECK ("canais_cliente"."tipo" in ('whatsapp_grupo','whatsapp_contato','email'))
);
--> statement-breakpoint
CREATE TABLE "clientes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"nome" text NOT NULL,
	"contatos" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text DEFAULT 'ativo' NOT NULL,
	"cofre_ref" text
);
--> statement-breakpoint
CREATE TABLE "decisoes_politica" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"demanda_id" uuid NOT NULL,
	"cliente_id" uuid NOT NULL,
	"agente" text NOT NULL,
	"ferramenta" text NOT NULL,
	"argumentos" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"nivel_autonomia" text NOT NULL,
	"decisao" text NOT NULL,
	"motivo" text NOT NULL,
	CONSTRAINT "decisoes_politica_decisao_ck" CHECK ("decisoes_politica"."decisao" in ('permitir','negar','exigir_aprovacao'))
);
--> statement-breakpoint
CREATE TABLE "demandas" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"cliente_id" uuid NOT NULL,
	"servico_id" text NOT NULL,
	"evento_id" uuid,
	"etapa" text NOT NULL,
	"tentativas_qa" integer DEFAULT 0 NOT NULL,
	"titulo" text NOT NULL,
	"atualizado_em" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "entregas" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"demanda_id" uuid NOT NULL,
	"repositorio" text NOT NULL,
	"versao" text NOT NULL,
	"ambiente" text NOT NULL,
	"url" text,
	"status" text NOT NULL,
	CONSTRAINT "entregas_ambiente_ck" CHECK ("entregas"."ambiente" in ('staging','producao'))
);
--> statement-breakpoint
CREATE TABLE "escopos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"demanda_id" uuid NOT NULL,
	"versao" integer NOT NULL,
	"conteudo" jsonb NOT NULL,
	"status" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "eventos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"canal_tipo" text NOT NULL,
	"canal_identificador" text NOT NULL,
	"id_externo" text NOT NULL,
	"texto" text NOT NULL,
	"recebido_em" timestamp with time zone DEFAULT now() NOT NULL,
	"origem_confianca" text DEFAULT 'cliente' NOT NULL,
	"cliente_id" uuid,
	"servico_id" text,
	"confianca" real,
	"resumo" text,
	"status" text NOT NULL,
	CONSTRAINT "eventos_canal_tipo_id_externo_uq" UNIQUE("canal_tipo","id_externo"),
	CONSTRAINT "eventos_origem_ck" CHECK ("eventos"."origem_confianca" in ('operador','sistema','cliente','externo','gerado'))
);
--> statement-breakpoint
CREATE TABLE "execucoes_agente" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"demanda_id" uuid NOT NULL,
	"agente" text NOT NULL,
	"modelo" text NOT NULL,
	"versao_prompt" text NOT NULL,
	"status" text DEFAULT 'em_andamento' NOT NULL,
	"turnos" integer DEFAULT 0 NOT NULL,
	"chamadas_ferramenta" integer DEFAULT 0 NOT NULL,
	"tokens" integer DEFAULT 0 NOT NULL,
	"custo_centavos" integer DEFAULT 0 NOT NULL,
	"rastro" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"finalizado_em" timestamp with time zone,
	CONSTRAINT "execucoes_agente_status_ck" CHECK ("execucoes_agente"."status" in ('em_andamento','concluida','interrompida_orcamento','interrompida_pausa','falhou'))
);
--> statement-breakpoint
CREATE TABLE "orcamentos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"escopo" text NOT NULL,
	"cliente_id" uuid,
	"limite_diario_centavos" integer NOT NULL,
	CONSTRAINT "orcamentos_escopo_cliente_uq" UNIQUE("escopo","cliente_id"),
	CONSTRAINT "orcamentos_escopo_ck" CHECK ("orcamentos"."escopo" in ('global','cliente'))
);
--> statement-breakpoint
CREATE TABLE "pausas" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"escopo" text NOT NULL,
	"alvo" text,
	"motivo" text NOT NULL,
	"encerrada_em" timestamp with time zone,
	CONSTRAINT "pausas_escopo_ck" CHECK ("pausas"."escopo" in ('global','cliente','agente'))
);
--> statement-breakpoint
CREATE TABLE "relatorios_qa" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"demanda_id" uuid NOT NULL,
	"portao" integer NOT NULL,
	"aprovado" boolean NOT NULL,
	"evidencias" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "relatorios_qa_portao_ck" CHECK ("relatorios_qa"."portao" in (1,2,3))
);
--> statement-breakpoint
CREATE TABLE "rotinas" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"cliente_id" uuid NOT NULL,
	"entrega_id" uuid,
	"tipo" text NOT NULL,
	"cron" text NOT NULL,
	"ultima_execucao" timestamp with time zone,
	"ultimo_resultado" text
);
--> statement-breakpoint
CREATE TABLE "servicos_contratados" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"cliente_id" uuid NOT NULL,
	"servico_id" text NOT NULL,
	"configuracao" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"nivel_autonomia" text DEFAULT 'N2' NOT NULL,
	CONSTRAINT "servicos_contratados_cliente_servico_uq" UNIQUE("cliente_id","servico_id"),
	CONSTRAINT "servicos_contratados_nivel_ck" CHECK ("servicos_contratados"."nivel_autonomia" in ('N0','N1','N2','N3'))
);
--> statement-breakpoint
CREATE TABLE "validacoes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"cliente_id" uuid NOT NULL,
	"evento_id" uuid,
	"campos" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"valor_declarado" numeric,
	"valor_sistema" numeric,
	"status" text NOT NULL,
	CONSTRAINT "validacoes_status_ck" CHECK ("validacoes"."status" in ('confere','divergente','nao_encontrado','pendente_verificacao','revisao_humana'))
);
--> statement-breakpoint
ALTER TABLE "aprovacoes" ADD CONSTRAINT "aprovacoes_demanda_id_demandas_id_fk" FOREIGN KEY ("demanda_id") REFERENCES "public"."demandas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "canais_cliente" ADD CONSTRAINT "canais_cliente_cliente_id_clientes_id_fk" FOREIGN KEY ("cliente_id") REFERENCES "public"."clientes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decisoes_politica" ADD CONSTRAINT "decisoes_politica_demanda_id_demandas_id_fk" FOREIGN KEY ("demanda_id") REFERENCES "public"."demandas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decisoes_politica" ADD CONSTRAINT "decisoes_politica_cliente_id_clientes_id_fk" FOREIGN KEY ("cliente_id") REFERENCES "public"."clientes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "demandas" ADD CONSTRAINT "demandas_cliente_id_clientes_id_fk" FOREIGN KEY ("cliente_id") REFERENCES "public"."clientes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "demandas" ADD CONSTRAINT "demandas_evento_id_eventos_id_fk" FOREIGN KEY ("evento_id") REFERENCES "public"."eventos"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entregas" ADD CONSTRAINT "entregas_demanda_id_demandas_id_fk" FOREIGN KEY ("demanda_id") REFERENCES "public"."demandas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "escopos" ADD CONSTRAINT "escopos_demanda_id_demandas_id_fk" FOREIGN KEY ("demanda_id") REFERENCES "public"."demandas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eventos" ADD CONSTRAINT "eventos_cliente_id_clientes_id_fk" FOREIGN KEY ("cliente_id") REFERENCES "public"."clientes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "execucoes_agente" ADD CONSTRAINT "execucoes_agente_demanda_id_demandas_id_fk" FOREIGN KEY ("demanda_id") REFERENCES "public"."demandas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orcamentos" ADD CONSTRAINT "orcamentos_cliente_id_clientes_id_fk" FOREIGN KEY ("cliente_id") REFERENCES "public"."clientes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relatorios_qa" ADD CONSTRAINT "relatorios_qa_demanda_id_demandas_id_fk" FOREIGN KEY ("demanda_id") REFERENCES "public"."demandas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rotinas" ADD CONSTRAINT "rotinas_cliente_id_clientes_id_fk" FOREIGN KEY ("cliente_id") REFERENCES "public"."clientes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rotinas" ADD CONSTRAINT "rotinas_entrega_id_entregas_id_fk" FOREIGN KEY ("entrega_id") REFERENCES "public"."entregas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "servicos_contratados" ADD CONSTRAINT "servicos_contratados_cliente_id_clientes_id_fk" FOREIGN KEY ("cliente_id") REFERENCES "public"."clientes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "validacoes" ADD CONSTRAINT "validacoes_cliente_id_clientes_id_fk" FOREIGN KEY ("cliente_id") REFERENCES "public"."clientes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "validacoes" ADD CONSTRAINT "validacoes_evento_id_eventos_id_fk" FOREIGN KEY ("evento_id") REFERENCES "public"."eventos"("id") ON DELETE no action ON UPDATE no action;