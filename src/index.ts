import {
  EmitContext,
  emitFile,
  listServices,
  getNamespaceFullName,
  navigateTypesInNamespace,
  Model,
  Namespace,
  Interface,
  Program,
  Type,
  Scalar,
} from "@typespec/compiler";

export type EmitterOptions = {
  "emitter-output-dir": string;
};

interface FieldInfo {
  name: string;
  type: Type;
  optional: boolean;
}

interface ServiceInfo {
  namespace: Namespace;
  iface: Interface;
  serviceName: string;
  models: Model[];
}

function extractFields(model: Model): FieldInfo[] {
  const fields: FieldInfo[] = [];
  for (const [name, prop] of model.properties) {
    fields.push({ name, type: prop.type, optional: prop.optional ?? false });
  }
  return fields;
}

function scalarName(type: Type): string {
  if (type.kind === "Scalar") return (type as Scalar).name;
  return "";
}

function typeToTs(type: Type): string {
  const n = scalarName(type);
  if (n === "string") return "string";
  if (n === "boolean") return "boolean";
  if (n === "int64" || n === "uint64") return "bigint";
  if (["int8","int16","int32","uint8","uint16","uint32","integer","float32","float64","float","decimal"].includes(n)) return "number";
  if (n === "bytes") return "Uint8Array";
  if (type.kind === "Intrinsic" && (type as any).name === "string") return "string";
  if (type.kind === "Intrinsic" && (type as any).name === "boolean") return "boolean";
  if (type.kind === "Model" && (type as Model).indexer) return `${typeToTs((type as Model).indexer!.value)}[]`;
  if (type.kind === "Model") return type.name || "unknown";
  return "unknown";
}

function writeJsonExpr(type: Type, varExpr: string): string {
  const n = scalarName(type);
  if (n === "string") return `w.writeString(${varExpr})`;
  if (n === "boolean") return `w.writeBool(${varExpr})`;
  if (n === "int32" || n === "int8" || n === "int16" || n === "integer") return `w.writeInt32(${varExpr})`;
  if (n === "int64") return `w.writeInt64(${varExpr})`;
  if (n === "uint32" || n === "uint8" || n === "uint16") return `w.writeUint32(${varExpr})`;
  if (n === "uint64") return `w.writeUint64(${varExpr})`;
  if (n === "float32") return `w.writeFloat32(${varExpr})`;
  if (n === "float64" || n === "float" || n === "decimal") return `w.writeFloat64(${varExpr})`;
  if (n === "bytes") return `w.writeBytes(${varExpr})`;
  if (type.kind === "Model" && (type as Model).indexer) {
    const elem = (type as Model).indexer!.value;
    const elemTs = typeToTs(elem);
    return `(() => { w.beginArray(${varExpr}.length); for (const _e of ${varExpr}) { w.nextElement(); ${writeJsonExpr(elem, "_e")}; } w.endArray(); })()`;
  }
  if (type.kind === "Model" && type.name) return `${type.name}Codec.writeJson(w, ${varExpr})`;
  return `w.writeString(String(${varExpr}))`;
}

function writeMsgPackExpr(type: Type, varExpr: string): string {
  const n = scalarName(type);
  if (n === "string") return `w.writeString(${varExpr})`;
  if (n === "boolean") return `w.writeBool(${varExpr})`;
  if (n === "int32" || n === "int8" || n === "int16" || n === "integer") return `w.writeInt32(${varExpr})`;
  if (n === "int64") return `w.writeInt64(${varExpr})`;
  if (n === "uint32" || n === "uint8" || n === "uint16") return `w.writeUint32(${varExpr})`;
  if (n === "uint64") return `w.writeUint64(${varExpr})`;
  if (n === "float32") return `w.writeFloat32(${varExpr})`;
  if (n === "float64" || n === "float" || n === "decimal") return `w.writeFloat64(${varExpr})`;
  if (n === "bytes") return `w.writeBytes(${varExpr})`;
  if (type.kind === "Model" && (type as Model).indexer) {
    const elem = (type as Model).indexer!.value;
    return `(() => { w.beginArray(${varExpr}.length); for (const _e of ${varExpr}) { w.nextElement(); ${writeMsgPackExpr(elem, "_e")}; } w.endArray(); })()`;
  }
  if (type.kind === "Model" && type.name) return `${type.name}Codec.writeMsgPack(w, ${varExpr})`;
  return `w.writeString(String(${varExpr}))`;
}

function readJsonExpr(type: Type): string {
  const n = scalarName(type);
  if (n === "string") return `r.readString()`;
  if (n === "boolean") return `r.readBool()`;
  if (n === "int32" || n === "int8" || n === "int16" || n === "integer") return `r.readInt32()`;
  if (n === "int64") return `r.readInt64()`;
  if (n === "uint32" || n === "uint8" || n === "uint16") return `r.readUint32()`;
  if (n === "uint64") return `r.readUint64()`;
  if (n === "float32") return `r.readFloat32()`;
  if (n === "float64" || n === "float" || n === "decimal") return `r.readFloat64()`;
  if (n === "bytes") return `r.readBytes()`;
  if (type.kind === "Model" && (type as Model).indexer) {
    const elem = (type as Model).indexer!.value;
    const elemTs = typeToTs(elem);
    return `(() => { const _a: ${elemTs}[] = []; r.beginArray(); while (r.hasNextElement()) { _a.push(${readJsonExpr(elem)}); } r.endArray(); return _a; })()`;
  }
  if (type.kind === "Model" && type.name) return `${type.name}Codec.decode(r)`;
  return `r.readString()`;
}

function collectServices(program: Program): ServiceInfo[] {
  const services = listServices(program);
  const result: ServiceInfo[] = [];
  function collectFromNs(ns: Namespace) {
    for (const [, iface] of ns.interfaces) {
      const models: Model[] = [];
      const seen = new Set<string>();
      navigateTypesInNamespace(ns, {
        model: (m: Model) => {
          if (m.name && !seen.has(m.name)) { models.push(m); seen.add(m.name); }
        },
      });
      result.push({ namespace: ns, iface, serviceName: iface.name, models });
    }
  }
  for (const svc of services) collectFromNs(svc.type);
  if (result.length === 0) {
    const globalNs = program.getGlobalNamespaceType();
    for (const [, ns] of globalNs.namespaces) collectFromNs(ns);
    collectFromNs(globalNs);
  }
  return result;
}

export async function $onEmit(context: EmitContext<EmitterOptions>) {
  const program = context.program;
  const outputDir = context.emitterOutputDir;
  const services = collectServices(program);

  for (const svc of services) {
    const L: string[] = [];
    L.push("// Generated by @specodec/typespec-specodec-ts. DO NOT EDIT.");
    L.push(`import type { SpecReader, SpecCodec } from "@specodec/specodec-ts";`);
    L.push(`import { JsonWriter, MsgPackWriter } from "@specodec/specodec-ts";`);
    L.push("");

    for (const m of svc.models) {
      if (!m.name) continue;
      const fields = extractFields(m);

      // interface
      L.push(`export interface ${m.name} {`);
      for (const f of fields) {
        L.push(`  ${f.name}${f.optional ? "?" : ""}: ${typeToTs(f.type)};`);
      }
      L.push("}");
      L.push("");

      // codec object
      L.push(`export const ${m.name}Codec: SpecCodec<${m.name}> = {`);

      // encodeJson
      L.push(`  encodeJson(obj: ${m.name}): Uint8Array {`);
      L.push(`    const w = new JsonWriter();`);
      L.push(`    w.beginObject();`);
      for (const f of fields) {
        if (f.optional) {
          L.push(`    if (obj.${f.name} !== undefined) { w.writeField("${f.name}"); ${writeJsonExpr(f.type, `obj.${f.name}`)}; }`);
        } else {
          L.push(`    w.writeField("${f.name}"); ${writeJsonExpr(f.type, `obj.${f.name}`)};`);
        }
      }
      L.push(`    w.endObject();`);
      L.push(`    return w.toBytes();`);
      L.push(`  },`);

      // encodeMsgPack
      L.push(`  encodeMsgPack(obj: ${m.name}): Uint8Array {`);
      const required = fields.filter(f => !f.optional);
      const optional = fields.filter(f => f.optional);
      if (optional.length === 0) {
        L.push(`    const w = new MsgPackWriter();`);
        L.push(`    w.beginObject(${fields.length});`);
      } else {
        L.push(`    let _n = ${required.length};`);
        for (const f of optional) {
          L.push(`    if (obj.${f.name} !== undefined) _n++;`);
        }
        L.push(`    const w = new MsgPackWriter();`);
        L.push(`    w.beginObject(_n);`);
      }
      for (const f of fields) {
        if (f.optional) {
          L.push(`    if (obj.${f.name} !== undefined) { w.writeField("${f.name}"); ${writeMsgPackExpr(f.type, `obj.${f.name}`)}; }`);
        } else {
          L.push(`    w.writeField("${f.name}"); ${writeMsgPackExpr(f.type, `obj.${f.name}`)};`);
        }
      }
      L.push(`    w.endObject();`);
      L.push(`    return w.toBytes();`);
      L.push(`  },`);

      // decode (shared for JSON + MsgPack)
      L.push(`  decode(r: SpecReader): ${m.name} {`);
      L.push(`    const obj: Partial<${m.name}> = {};`);
      L.push(`    r.beginObject();`);
      L.push(`    while (r.hasNextField()) {`);
      L.push(`      switch (r.readFieldName()) {`);
      for (const f of fields) {
        L.push(`        case "${f.name}": obj.${f.name} = ${readJsonExpr(f.type)}; break;`);
      }
      L.push(`        default: r.skip();`);
      L.push(`      }`);
      L.push(`    }`);
      L.push(`    r.endObject();`);
      L.push(`    return obj as ${m.name};`);
      L.push(`  },`);

      L.push(`};`);
      L.push("");
    }

    const fileName = svc.serviceName.replace(/([A-Z])/g, (m, c, i) => (i ? "_" : "") + c.toLowerCase());
    await emitFile(program, { path: `${outputDir}/${fileName}_types.ts`, content: L.join("\n") });
  }
}
