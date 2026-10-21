package main

import (
	"crypto/sha1"
	"encoding/hex"
	"fmt"
	"sort"
	"strconv"
	"strings"
	"sync/atomic"
	"time"
)

func sha1Hex(s string) string {
	h := sha1.Sum([]byte(s))
	return hex.EncodeToString(h[:])
}

// infoTexto es un INFO creíble y coherente con la versión, la instalación
// fingida (identidad) y el estado real de la trampa (clientes conectados,
// claves de la vista del atacante, hora de arranque). Nada sale del reloj ni
// es común a toda la flota.
func (s *servidor) infoTexto(cli *cliente, args []string) string {
	secciones := map[string]bool{}
	for _, a := range args[1:] {
		secciones[strings.ToLower(a)] = true
	}
	quiere := func(n string) bool {
		if len(secciones) == 0 || secciones["all"] || secciones["everything"] || secciones["default"] {
			return true
		}
		return secciones[n]
	}

	id := s.id
	ahora := time.Now()
	up := id.uptime(ahora)
	var b strings.Builder

	esc, bytesDatos := s.banco.espacio(cli.vista)
	usada := id.memBase + int64(bytesDatos)
	rss := id.rssBase + int64(bytesDatos)
	if rss < usada {
		rss = usada + 1<<20
	}

	if quiere("server") {
		b.WriteString("# Server\r\n")
		b.WriteString("redis_version:" + id.version + "\r\n")
		b.WriteString("redis_git_sha1:00000000\r\n")
		b.WriteString("redis_git_dirty:0\r\n")
		b.WriteString("redis_build_id:" + id.buildID + "\r\n")
		b.WriteString("redis_mode:standalone\r\n")
		b.WriteString("os:" + id.sistema + "\r\n")
		b.WriteString("arch_bits:64\r\n")
		if id.nver >= 700 {
			b.WriteString("monotonic_clock:POSIX clock_gettime\r\n")
		}
		b.WriteString("multiplexing_api:epoll\r\n")
		b.WriteString("atomicvar_api:c11-builtin\r\n")
		b.WriteString("gcc_version:" + id.gcc + "\r\n")
		b.WriteString("process_id:" + strconv.Itoa(id.pid) + "\r\n")
		b.WriteString("process_supervised:" + id.supervisado + "\r\n")
		b.WriteString("run_id:" + id.runID + "\r\n")
		b.WriteString("tcp_port:" + strconv.Itoa(id.puerto) + "\r\n")
		b.WriteString("server_time_usec:" + strconv.FormatInt(ahora.UnixMicro(), 10) + "\r\n")
		b.WriteString("uptime_in_seconds:" + strconv.FormatInt(up, 10) + "\r\n")
		b.WriteString("uptime_in_days:" + strconv.FormatInt(up/86400, 10) + "\r\n")
		b.WriteString("hz:10\r\n")
		b.WriteString("configured_hz:10\r\n")
		b.WriteString("lru_clock:" + strconv.FormatInt(ahora.Unix()&0xffffff, 10) + "\r\n")
		b.WriteString("executable:" + id.ejecutable + "\r\n")
		b.WriteString("config_file:" + id.ficheroConf + "\r\n")
		if id.nver >= 700 {
			b.WriteString("io_threads_active:0\r\n")
		}
		b.WriteString("\r\n")
	}
	if quiere("clients") {
		b.WriteString("# Clients\r\n")
		// Las conexiones de su misma IP: las mismas que enseña CLIENT LIST.
		b.WriteString("connected_clients:" + strconv.Itoa(s.banco.conectados(cli.vista)) + "\r\n")
		b.WriteString("cluster_connections:0\r\n")
		b.WriteString("maxclients:10000\r\n")
		b.WriteString("client_recent_max_input_buffer:20480\r\n")
		b.WriteString("client_recent_max_output_buffer:0\r\n")
		b.WriteString("blocked_clients:0\r\n")
		b.WriteString("tracking_clients:0\r\n")
		b.WriteString("clients_in_timeout_table:0\r\n")
		b.WriteString("\r\n")
	}
	if quiere("memory") {
		b.WriteString("# Memory\r\n")
		b.WriteString("used_memory:" + strconv.FormatInt(usada, 10) + "\r\n")
		b.WriteString("used_memory_human:" + humano(usada) + "\r\n")
		b.WriteString("used_memory_rss:" + strconv.FormatInt(rss, 10) + "\r\n")
		b.WriteString("used_memory_rss_human:" + humano(rss) + "\r\n")
		b.WriteString("used_memory_peak:" + strconv.FormatInt(rss, 10) + "\r\n")
		b.WriteString("used_memory_peak_human:" + humano(rss) + "\r\n")
		b.WriteString("used_memory_lua:0\r\n")
		b.WriteString("used_memory_scripts:0\r\n")
		b.WriteString("number_of_cached_scripts:0\r\n")
		b.WriteString("maxmemory:0\r\n")
		b.WriteString("maxmemory_human:0B\r\n")
		b.WriteString("maxmemory_policy:noeviction\r\n")
		b.WriteString("mem_fragmentation_ratio:" + fmt.Sprintf("%.2f", float64(rss)/float64(usada)) + "\r\n")
		b.WriteString("mem_allocator:" + id.jemalloc + "\r\n")
		b.WriteString("total_system_memory:" + strconv.FormatInt(id.memSistema, 10) + "\r\n")
		b.WriteString("total_system_memory_human:" + humano(id.memSistema) + "\r\n")
		b.WriteString("\r\n")
	}
	if quiere("persistence") {
		cambios, ultimo := 0, id.arranque
		s.banco.conVista(func() { cambios, ultimo = cli.vista.cambios, cli.vista.ultimoSave })
		if ultimo.IsZero() {
			ultimo = id.arranque
		}
		b.WriteString("# Persistence\r\n")
		b.WriteString("loading:0\r\n")
		b.WriteString("async_loading:0\r\n")
		b.WriteString("rdb_changes_since_last_save:" + strconv.Itoa(cambios) + "\r\n")
		b.WriteString("rdb_bgsave_in_progress:0\r\n")
		b.WriteString("rdb_last_save_time:" + strconv.FormatInt(ultimo.Unix(), 10) + "\r\n")
		b.WriteString("rdb_last_bgsave_status:ok\r\n")
		b.WriteString("aof_enabled:0\r\n")
		b.WriteString("aof_rewrite_in_progress:0\r\n")
		b.WriteString("aof_last_bgrewrite_status:ok\r\n")
		b.WriteString("aof_last_write_status:ok\r\n")
		b.WriteString("\r\n")
	}
	if quiere("stats") {
		b.WriteString("# Stats\r\n")
		conexiones := atomic.LoadInt64(&contadorCli)
		b.WriteString("total_connections_received:" + strconv.FormatInt(conexiones, 10) + "\r\n")
		b.WriteString("total_commands_processed:" + strconv.FormatInt(conexiones*3+1, 10) + "\r\n")
		b.WriteString("instantaneous_ops_per_sec:0\r\n")
		b.WriteString("rejected_connections:0\r\n")
		b.WriteString("sync_full:0\r\n")
		b.WriteString("expired_keys:" + strconv.FormatInt(expiradosTotal(s), 10) + "\r\n")
		b.WriteString("evicted_keys:0\r\n")
		b.WriteString("keyspace_hits:0\r\n")
		b.WriteString("keyspace_misses:0\r\n")
		b.WriteString("pubsub_channels:0\r\n")
		b.WriteString("total_net_input_bytes:0\r\n")
		b.WriteString("total_net_output_bytes:0\r\n")
		b.WriteString("\r\n")
	}
	if quiere("replication") {
		rol, mhost, mport := "master", "", ""
		s.banco.conVista(func() {
			if cli.vista.replica[0] != "" {
				rol, mhost, mport = "slave", cli.vista.replica[0], cli.vista.replica[1]
			}
		})
		b.WriteString("# Replication\r\n")
		b.WriteString("role:" + rol + "\r\n")
		if rol == "slave" {
			b.WriteString("master_host:" + recortarCodificado(mhost, 128) + "\r\n")
			b.WriteString("master_port:" + recortarCodificado(mport, 16) + "\r\n")
			b.WriteString("master_link_status:down\r\n")
			b.WriteString("master_last_io_seconds_ago:-1\r\n")
			b.WriteString("master_sync_in_progress:0\r\n")
			b.WriteString("slave_read_only:1\r\n")
		}
		b.WriteString("connected_slaves:0\r\n")
		b.WriteString("master_failover_state:no-failover\r\n")
		b.WriteString("master_replid:" + id.replID + "\r\n")
		b.WriteString("master_replid2:0000000000000000000000000000000000000000\r\n")
		b.WriteString("master_repl_offset:0\r\n")
		b.WriteString("\r\n")
	}
	if quiere("cpu") {
		b.WriteString("# CPU\r\n")
		b.WriteString("used_cpu_sys:" + fmt.Sprintf("%.6f", id.cpuSys*float64(up)) + "\r\n")
		b.WriteString("used_cpu_user:" + fmt.Sprintf("%.6f", id.cpuUser*float64(up)) + "\r\n")
		b.WriteString("\r\n")
	}
	if quiere("errorstats") && id.nver >= 700 {
		b.WriteString("# Errorstats\r\n")
		codigos := make([]string, 0, len(cli.errores))
		for k := range cli.errores {
			codigos = append(codigos, k)
		}
		sort.Strings(codigos)
		for _, k := range codigos {
			b.WriteString("errorstat_" + k + ":count=" + strconv.FormatInt(cli.errores[k], 10) + "\r\n")
		}
		b.WriteString("\r\n")
	}
	if quiere("cluster") {
		b.WriteString("# Cluster\r\n")
		b.WriteString("cluster_enabled:0\r\n")
		b.WriteString("\r\n")
	}
	if quiere("keyspace") {
		b.WriteString("# Keyspace\r\n")
		dbs := make([]int, 0, len(esc))
		for db := range esc {
			dbs = append(dbs, db)
		}
		sort.Ints(dbs)
		for _, db := range dbs {
			x := esc[db]
			if x.claves == 0 {
				continue // una base vacía no sale, como en Redis
			}
			b.WriteString(fmt.Sprintf("db%d:keys=%d,expires=%d,avg_ttl=%d\r\n", db, x.claves, x.conPlazo, x.mediaMs))
		}
		b.WriteString("\r\n")
	}
	return strings.TrimRight(b.String(), "\r\n") + "\r\n"
}

func expiradosTotal(s *servidor) int64 {
	e, _ := s.banco.estadisticas()
	return e
}

func humano(n int64) string {
	switch {
	case n >= 1<<30:
		return fmt.Sprintf("%.2fG", float64(n)/(1<<30))
	case n >= 1<<20:
		return fmt.Sprintf("%.2fM", float64(n)/(1<<20))
	case n >= 1<<10:
		return fmt.Sprintf("%.2fK", float64(n)/(1<<10))
	}
	return strconv.FormatInt(n, 10) + "B"
}
