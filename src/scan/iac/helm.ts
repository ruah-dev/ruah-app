// Helm chart detector. Nothing is rendered: templates are read for the kinds
// they declare and for the `.Values.*` paths their image / replicas / port
// lines use; those paths are resolved against values.yaml. Chart
// dependencies (Chart.yaml `dependencies`, requirements.yaml) that are
// well-known products (postgresql, redis, …) become items the workloads use.
// Charts vendored under another chart's charts/ directory are dependencies of
// that chart, not charts of their own.
import { infraFromImage } from "../detectors/compose.js";
import { parseYaml, splitYamlDocuments, yamlGet, yamlKeys, yamlList, yamlString, type YamlValue } from "../mini-yaml.js";
import type { ScanContext } from "../types.js";
import { dirname, joinRel } from "../walk.js";
import { byString, hostsIn, readCached, safeSetting, uniq, type InfraCategory, type InfraGroup, type InfraItem, type InfraLink, type InfraReport } from "./model.js";

const WORKLOAD_RE = /^(Deployment|StatefulSet|DaemonSet|Job|CronJob|Rollout)$/;

function valuesAt(values: YamlValue, path: string): YamlValue | undefined {
  let cur: YamlValue | undefined = values;
  for (const k of path.split(".")) cur = yamlGet(cur, k);
  return cur;
}

function kindCategory(name: string): { key: string; category: InfraCategory; label: string } | undefined {
  const norm = name.toLowerCase().replace(/^postgresql(-ha)?$/, "postgres").replace(/^mongodb(-sharded)?$/, "mongo").replace(/^redis-cluster$/, "redis");
  const kind = infraFromImage(norm);
  if (kind === undefined) return undefined;
  const category: InfraCategory = kind.type === "datastore" ? "database" : kind.key === "redis" ? "cache" : kind.type === "queue" ? "queue" : kind.type === "gateway" ? "gateway" : "release";
  return { key: kind.key, category, label: kind.label };
}

export function detectHelm(ctx: ScanContext, report: InfraReport, chartDirs: Set<string>): void {
  const dirs = [...chartDirs].sort();
  // Vendored subcharts (<chart>/charts/<sub>) belong to their parent.
  const top = dirs.filter((d) => !dirs.some((p) => p !== d && d.startsWith(`${p}/charts/`)));
  for (const dir of top) {
    const chartFile = ctx.fl.fileSet.has(joinRel(dir, "Chart.yaml")) ? joinRel(dir, "Chart.yaml") : joinRel(dir, "Chart.yml");
    const chartText = readCached(ctx, chartFile);
    report.filesRead++;
    if (chartText === null) continue;
    const chart = parseYaml(chartText);
    const chartName = yamlString(yamlGet(chart, "name")) ?? dir.slice(dir.lastIndexOf("/") + 1);
    const appVersion = yamlString(yamlGet(chart, "appVersion"));
    const chartType = yamlString(yamlGet(chart, "type"));
    const valuesFile = ["values.yaml", "values.yml"].map((n) => joinRel(dir, n)).find((f) => ctx.fl.fileSet.has(f));
    const valuesText = valuesFile !== undefined ? readCached(ctx, valuesFile) : null;
    if (valuesText !== null) report.filesRead++;
    const values: YamlValue = valuesText !== null ? parseYaml(valuesText) : null;
    const valuesLines = valuesText?.split(/\r?\n/) ?? [];
    const envValues = ctx.fl.files.filter((f) => dirname(f) === dir && /^values[-.].+\.ya?ml$/.test(f.slice(dir === "" ? 0 : dir.length + 1)));

    const group: InfraGroup = {
      key: `helm:${dir}`,
      tool: "helm",
      name: `Helm: ${chartName}`,
      kind: chartType === "library" ? "library chart" : "chart",
      ...(dir !== "" ? { path: dir } : {}),
      files: [chartFile, ...(valuesFile !== undefined ? [valuesFile] : [])],
      settings: {
        chart: chartName,
        ...(yamlString(yamlGet(chart, "version")) !== undefined ? { version: yamlString(yamlGet(chart, "version")) ?? "" } : {}),
        ...(appVersion !== undefined ? { appVersion } : {}),
        ...(envValues.length > 0 ? { valuesFiles: envValues.map((f) => f.slice(f.lastIndexOf("/") + 1)).join(", ") } : {}),
      },
      details: [],
      hints: [chartName],
    };
    const items: InfraItem[] = [];
    const links: InfraLink[] = [];
    const lineOfValue = (path: string): number => {
      const last = path.split(".").pop() ?? path;
      const i = valuesLines.findIndex((l) => new RegExp(`^\\s*${last.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:`).test(l));
      return i + 1 || 1;
    };

    // Hosts in values (env / config maps): workloads call them.
    const valueHosts: string[] = [];
    const walk = (v: YamlValue | undefined, key: string, depth: number): void => {
      if (depth > 6 || v === undefined || v === null) return;
      if (typeof v === "string") {
        valueHosts.push(...hostsIn(v, key));
        return;
      }
      if (Array.isArray(v)) {
        for (const x of v) walk(x, key, depth + 1);
        return;
      }
      for (const k of yamlKeys(v)) if (!/pass|secret|token|key/i.test(k)) walk(yamlGet(v, k), k, depth + 1);
    };
    walk(yamlGet(values, "env") ?? null, "", 0);
    walk(yamlGet(values, "config") ?? null, "", 0);
    walk(yamlGet(values, "extraEnv") ?? null, "", 0);

    const templates = ctx.fl.files.filter((f) => f.startsWith(joinRel(dir, "templates/")) && /\.ya?ml$/.test(f)).sort();
    const workloadFiles: { file: string; kind: string; line: number; doc: string }[] = [];
    const routeFiles: { file: string; kind: string; line: number }[] = [];
    for (const f of templates.slice(0, 200)) {
      const text = readCached(ctx, f);
      report.filesRead++;
      if (text === null) continue;
      for (const doc of splitYamlDocuments(text)) {
        const m = /^kind:\s*["']?([A-Za-z]+)/m.exec(doc.text);
        if (m === null) continue;
        const kind = m[1] ?? "";
        const line = doc.start + doc.text.slice(0, m.index).split("\n").length;
        if (WORKLOAD_RE.test(kind)) workloadFiles.push({ file: f, kind, line, doc: doc.text });
        else if (/^(Ingress|IngressRoute|HTTPRoute)$/.test(kind)) routeFiles.push({ file: f, kind, line });
        else group.details.push(`${kind} (${f.slice(f.lastIndexOf("/") + 1)})`);
      }
    }

    for (const w of workloadFiles) {
      const nameLine = /^\s*name:\s*(.+)$/m.exec(w.doc.slice(w.doc.indexOf("metadata:")))?.[1]?.trim() ?? "";
      let name = chartName;
      if (!nameLine.includes("{{")) name = nameLine.replace(/^["']|["']$/g, "") || chartName;
      else {
        const suffix = /\}\}\s*-?([A-Za-z0-9-]+)["']?\s*$/.exec(nameLine)?.[1];
        if (suffix !== undefined) name = `${chartName}-${suffix}`;
        else if (workloadFiles.length > 1) {
          const base = w.file.slice(w.file.lastIndexOf("/") + 1).replace(/\.ya?ml$/, "").replace(/-?(deployment|statefulset|daemonset|cronjob|job)$/i, "");
          if (base !== "" && base !== chartName) name = `${chartName}-${base}`;
        }
      }
      // Image: `.Values.<prefix>.image.repository` / `.tag`, or `.Values.<prefix>.image` as a string, or a literal.
      const imageLine = /^\s*image:\s*(.+)$/m.exec(w.doc)?.[1] ?? "";
      const valuePaths = [...imageLine.matchAll(/\.Values\.([A-Za-z0-9_.]+)/g)].map((m) => m[1] ?? "");
      let image: string | undefined;
      let imageEvidence: number | undefined;
      const repoPath = valuePaths.find((p) => /(^|\.)(repository|image|name)$/.test(p) && !/tag$/.test(p));
      if (repoPath !== undefined) {
        const repoVal = yamlString(valuesAt(values, repoPath));
        const registry = yamlString(valuesAt(values, repoPath.replace(/(repository|name)$/, "registry")));
        const tagPath = valuePaths.find((p) => /tag$/.test(p));
        const tag = (tagPath !== undefined ? yamlString(valuesAt(values, tagPath)) : undefined) || appVersion;
        if (repoVal !== undefined && repoVal !== "") {
          const full = registry !== undefined && registry !== "" && !repoVal.startsWith(registry) && repoPath.endsWith("repository") ? `${registry}/${repoVal}` : repoVal;
          image = tag !== undefined && tag !== "" && !full.includes(":") ? `${full}:${tag}` : full;
          imageEvidence = lineOfValue(repoPath);
        }
      } else if (imageLine !== "" && !imageLine.includes("{{")) {
        image = imageLine.replace(/^["']|["']$/g, "").trim();
      }
      const replicasRef = /^\s*replicas:\s*\{\{-?\s*\.Values\.([A-Za-z0-9_.]+)/m.exec(w.doc)?.[1];
      const replicas = replicasRef !== undefined ? yamlString(valuesAt(values, replicasRef)) : /^\s*replicas:\s*(\d+)/m.exec(w.doc)?.[1];
      const portRef = /containerPort:\s*\{\{-?\s*\.Values\.([A-Za-z0-9_.]+)/.exec(w.doc)?.[1];
      const port = portRef !== undefined ? yamlString(valuesAt(values, portRef)) : /containerPort:\s*(\d+)/.exec(w.doc)?.[1];
      const settings: Record<string, string> = {};
      if (replicas !== undefined) settings.replicas = replicas;
      if (image !== undefined) settings.image = image;
      if (port !== undefined) settings.ports = port;
      const svcType = yamlString(valuesAt(values, "service.type"));
      const svcPort = yamlString(valuesAt(values, "service.port"));
      if (svcType !== undefined || svcPort !== undefined) settings.service = `${svcType ?? "ClusterIP"}${svcPort !== undefined ? ` ${svcPort}` : ""}`;
      const kc = image !== undefined ? kindCategory(image.replace(/^.*\//, "").replace(/:.*$/, "")) : undefined;
      const item: InfraItem = {
        key: `helm:${dir}:${w.kind}/${name}`,
        group: group.key,
        tool: "helm",
        kind: w.kind,
        address: `${chartName}/${w.kind}/${name}`,
        name,
        category: kc?.category ?? (/Job$/.test(w.kind) ? "job" : "workload"),
        file: w.file,
        line: w.line,
        settings: Object.fromEntries(Object.entries(settings).map(([k, v]) => [k, safeSetting(k, v)]).filter((e): e is [string, string] => e[1] !== undefined)),
        details: [],
        hints: uniq([name, chartName]),
        images: image !== undefined ? [image] : [],
        tech: [`Helm ${w.kind}`],
        ...(kc !== undefined ? { infraKind: kc.key } : {}),
        ...(valueHosts.length > 0 ? { refs: uniq(valueHosts).map((h) => `host:${h}`) } : {}),
      };
      items.push(item);
      if (image !== undefined) links.push({ from: { item: item.key }, to: { image }, label: "runs", kind: "deploy", evidence: [imageEvidence !== undefined && valuesFile !== undefined ? `${valuesFile}:${imageEvidence}` : `${w.file}:${w.line}`] });
    }

    // Ingress from values (enabled + hosts).
    if (routeFiles.length > 0) {
      const ing = yamlGet(values, "ingress");
      const enabled = yamlString(yamlGet(ing, "enabled"));
      const hosts = yamlList(yamlGet(ing, "hosts")).map((h) => (typeof h === "string" ? h : yamlString(yamlGet(h, "host")) ?? "")).filter((h) => h !== "");
      const r = routeFiles[0];
      if (r !== undefined && enabled !== "false") {
        const item: InfraItem = {
          key: `helm:${dir}:${r.kind}/${chartName}`,
          group: group.key,
          tool: "helm",
          kind: r.kind,
          address: `${chartName}/${r.kind}/${chartName}`,
          name: hosts[0] ?? `${chartName} ingress`,
          category: "gateway",
          file: r.file,
          line: r.line,
          settings: {
            ...(hosts.length > 0 ? { hosts: hosts.join(", ") } : {}),
            ...(yamlString(yamlGet(ing, "className")) !== undefined ? { class: yamlString(yamlGet(ing, "className")) ?? "" } : {}),
            ...(enabled !== undefined ? { enabled } : {}),
          },
          details: [],
          hints: uniq([chartName, ...hosts]),
          images: [],
          tech: [`Helm ${r.kind}`],
        };
        items.push(item);
        const main = items.find((i) => i.category === "workload");
        if (main !== undefined) links.push({ from: { item: item.key }, to: { item: main.key }, label: (hosts[0] ?? "routes").slice(0, 40), kind: "sync", evidence: [`${r.file}:${r.line}`] });
      }
    }

    // Dependencies.
    let deps = yamlList(yamlGet(chart, "dependencies"));
    const req = joinRel(dir, "requirements.yaml");
    if (deps.length === 0 && ctx.fl.fileSet.has(req)) {
      const t = readCached(ctx, req);
      if (t !== null) deps = yamlList(yamlGet(parseYaml(t), "dependencies"));
    }
    const chartLines = chartText.split(/\r?\n/);
    for (const d of deps) {
      const depName = yamlString(yamlGet(d, "name"));
      if (depName === undefined) continue;
      const alias = yamlString(yamlGet(d, "alias")) ?? depName;
      const kc = kindCategory(depName);
      const line = chartLines.findIndex((l) => l.includes(`name: ${depName}`)) + 1 || 1;
      if (kc === undefined) {
        group.details.push(`dependency ${depName}${yamlString(yamlGet(d, "version")) !== undefined ? ` ${yamlString(yamlGet(d, "version"))}` : ""}`);
        continue;
      }
      const item: InfraItem = {
        key: `helm:${dir}:dependency/${alias}`,
        group: group.key,
        tool: "helm",
        kind: "dependency",
        address: `${chartName}/dependency/${alias}`,
        name: alias,
        category: kc.category,
        file: chartFile,
        line,
        settings: {
          chart: depName,
          ...(yamlString(yamlGet(d, "version")) !== undefined ? { version: yamlString(yamlGet(d, "version")) ?? "" } : {}),
          ...(yamlString(yamlGet(d, "repository")) !== undefined ? { repository: yamlString(yamlGet(d, "repository")) ?? "" } : {}),
          ...(yamlString(yamlGet(d, "condition")) !== undefined ? { condition: yamlString(yamlGet(d, "condition")) ?? "" } : {}),
        },
        details: [],
        hints: uniq([alias, `${chartName}-${alias}`]),
        images: [],
        tech: [`Helm chart ${depName}`],
        infraKind: kc.key,
      };
      items.push(item);
      links.push({ from: { item: item.key }, to: { infraKind: kc.key }, label: "runs", kind: "deploy", evidence: [`${chartFile}:${line}`] });
      for (const w of items.filter((i) => i.category === "workload" || i.category === "job")) {
        links.push({ from: { item: w.key }, to: { item: item.key }, label: kc.label, kind: kc.category === "database" ? "data" : kc.category === "queue" || kc.category === "cache" ? "async" : "sync", evidence: [`${chartFile}:${line}`] });
      }
    }
    for (const sub of dirs.filter((d) => d.startsWith(`${dir}/charts/`))) group.details.push(`vendored subchart ${sub.slice(dir.length + 8)}`);
    group.details = uniq(group.details).sort(byString);
    report.groups.push(group);
    report.items.push(...items.sort((a, b) => byString(a.key, b.key)));
    report.links.push(...links);
  }
}
