#!/usr/bin/env node
// Dependency-free validation for the JSON Schema subset used by this documentation project.
// This is NOT the production request runtime or a full JSON Schema implementation.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const errors=[];let checks=0;
const fail=m=>errors.push(m);
function walk(dir){return fs.readdirSync(dir,{withFileTypes:true}).flatMap(d=>['node_modules','.git','dist','coverage','runtime','outputs'].includes(d.name)?[]:d.isDirectory()?walk(path.join(dir,d.name)):[path.join(dir,d.name)]);}
function readJSON(p){try{return JSON.parse(fs.readFileSync(p,'utf8'));}catch(e){fail(`${path.relative(root,p)}: invalid JSON: ${e.message}`);return null;}}
function pointer(value,p){if(p==='')return value;if(!p.startsWith('/'))throw Error('Invalid JSON Pointer');for(const key of p.slice(1).split('/').map(x=>x.replace(/~1/g,'/').replace(/~0/g,'~'))){if(['__proto__','prototype','constructor'].includes(key))throw Error('Unsafe pointer');if(value===null||typeof value!=='object'||!Object.hasOwn(value,key))throw Error(`Missing pointer ${p}`);value=value[key];}return value;}
function typeOK(v,t){switch(t){case'object':return v!==null&&typeof v==='object'&&!Array.isArray(v);case'array':return Array.isArray(v);case'integer':return Number.isInteger(v);case'number':return typeof v==='number'&&Number.isFinite(v);case'null':return v===null;default:return typeof v===t;}}
const eq=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
function validate(v,s,doc=s,loc='$'){
 if(s===true)return[];if(s===false)return[`${loc}: forbidden`];const e=[];
 if(s.$ref){if(!s.$ref.startsWith('#/'))return[`${loc}: unsupported reference`];return validate(v,pointer(doc,s.$ref.slice(1)),doc,loc);}
 if(s.type&&!(Array.isArray(s.type)?s.type:[s.type]).some(t=>typeOK(v,t)))e.push(`${loc}: expected ${JSON.stringify(s.type)}`);
 if(Object.hasOwn(s,'const')&&!eq(v,s.const))e.push(`${loc}: const mismatch`);
 if(s.enum&&!s.enum.some(x=>eq(v,x)))e.push(`${loc}: enum mismatch`);
 if(typeof v==='string'){if(s.minLength!==undefined&&v.length<s.minLength)e.push(`${loc}: too short`);if(s.pattern&&!new RegExp(s.pattern).test(v))e.push(`${loc}: pattern mismatch`);}
 if(typeof v==='number'){if(s.minimum!==undefined&&v<s.minimum)e.push(`${loc}: below minimum`);if(s.maximum!==undefined&&v>s.maximum)e.push(`${loc}: above maximum`);}
 if(Array.isArray(v)){if(s.minItems!==undefined&&v.length<s.minItems)e.push(`${loc}: too few items`);if(s.uniqueItems&&new Set(v.map(x=>JSON.stringify(x))).size!==v.length)e.push(`${loc}: duplicate items`);if(s.items)v.forEach((x,i)=>e.push(...validate(x,s.items,doc,`${loc}/${i}`)));}
 if(typeOK(v,'object')){for(const k of s.required||[])if(!Object.hasOwn(v,k))e.push(`${loc}: missing ${k}`);for(const[k,x]of Object.entries(v)){if(s.properties&&Object.hasOwn(s.properties,k))e.push(...validate(x,s.properties[k],doc,`${loc}/${k}`));else if(s.additionalProperties===false)e.push(`${loc}: unexpected ${k}`);else if(typeOK(s.additionalProperties,'object'))e.push(...validate(x,s.additionalProperties,doc,`${loc}/${k}`));}}
 if(s.allOf)for(const sub of s.allOf)e.push(...validate(v,sub,doc,loc));
 if(s.anyOf&&!s.anyOf.some(sub=>validate(v,sub,doc,loc).length===0))e.push(`${loc}: anyOf failed`);
 if(s.oneOf&&s.oneOf.filter(sub=>validate(v,sub,doc,loc).length===0).length!==1)e.push(`${loc}: oneOf failed`);
 if(s.not&&validate(v,s.not,doc,loc).length===0)e.push(`${loc}: not failed`);
 if(s.if&&validate(v,s.if,doc,loc).length===0&&s.then)e.push(...validate(v,s.then,doc,loc));
 return e;
}
const supported=new Set(['$schema','$id','$ref','$defs','title','description','type','properties','required','additionalProperties','const','enum','minLength','pattern','minimum','maximum','minItems','uniqueItems','items','oneOf','anyOf','allOf','not','if','then','default']);
function schemaKeywords(s,label){if(typeof s==='boolean')return;for(const[k,v]of Object.entries(s)){if(!supported.has(k))fail(`${label}: unsupported Schema keyword ${k}`);if(['properties','$defs'].includes(k))for(const[n,d]of Object.entries(v))schemaKeywords(d,`${label}/${k}/${n}`);else if(['items','not','if','then'].includes(k)&&typeof v==='object')schemaKeywords(v,`${label}/${k}`);else if(k==='additionalProperties'&&typeof v==='object')schemaKeywords(v,`${label}/${k}`);else if(['oneOf','anyOf','allOf'].includes(k))v.forEach((x,i)=>schemaKeywords(x,`${label}/${k}/${i}`));}}
const files=walk(root),jsons=new Map();
for(const p of files.filter(p=>p.endsWith('.json'))){const d=readJSON(p);if(d!==null)jsons.set(p,d);checks++;}
const schemas=new Map();for(const[p,d]of jsons)if(path.dirname(p)===path.join(root,'schemas')){schemas.set(path.basename(p),d);schemaKeywords(d,path.relative(root,p));}
for(const p of files.filter(p=>p.endsWith('.md'))){const text=fs.readFileSync(p,'utf8');const withoutCode=text.replace(/```[\s\S]*?```/g,'');for(const m of withoutCode.matchAll(/!?\[[^\]]*\]\((<[^>]+>|[^\s)]+)(?:\s+"[^"]*")?\)/g)){let target=m[1].replace(/^<|>$/g,'');if(/^[a-z][a-z0-9+.-]*:/i.test(target)||target.startsWith('#'))continue;target=target.split('#')[0].split('?')[0];if(!target)continue;let decoded;try{decoded=decodeURIComponent(target);}catch{fail(`${p}: invalid link encoding`);continue;}if(!fs.existsSync(path.resolve(path.dirname(p),decoded)))fail(`${path.relative(root,p)}: broken link ${target}`);checks++;}}
const index=jsons.get(path.join(root,'examples/index.json'));
for(const item of index?.examples||[]){const p=path.join(root,'examples',item.file),d=jsons.get(p),s=schemas.get(item.schema);if(!d||!s){fail(`Missing example/schema ${item.file}`);continue;}for(const e of validate(d,s))fail(`${item.file}: ${e}`);checks++;}
const services=new Map();const operations=[];
for(const[p,d]of jsons){if(path.dirname(p)===path.join(root,'examples/services')){services.set(d.id,d);try{const u=new URL(d.baseUrl);if(d.baseUrl!==u.origin||u.username||u.password)fail(`${d.id}: baseUrl must be origin only`);for(const origin of d.allowedOrigins){if(new URL(origin).origin!==origin)fail(`${d.id}: invalid allowed origin`);if(origin.startsWith('http:')&&!d.protocolExceptions?.some(x=>x.origin===origin))fail(`${d.id}: missing explicit HTTP exception`);}}catch{fail(`${d.id}: invalid URL`);}}
 if(path.dirname(p)===path.join(root,'examples/operations'))operations.push(d);}
for(const op of operations){if(!services.has(op.service))fail(`${op.id}: missing service`);schemaKeywords(op.arguments,`${op.id}/arguments`);const args={};for(const[k,v]of Object.entries(op.arguments.properties||{}))if(Object.hasOwn(v,'default'))args[k]=v.default;for(const e of validate(args,op.arguments))fail(`${op.id} defaults: ${e}`);const seen=new Set();for(const b of op.bindings){if(!Object.hasOwn(op.arguments.properties||{},b.argument))fail(`${op.id}: unknown bound argument`);const key=b.target+b.pointer;if(seen.has(key))fail(`${op.id}: duplicate binding`);seen.add(key);try{pointer(op.request[b.target],b.pointer);}catch(e){fail(`${op.id}: ${e.message}`);}}
 for(const name of Object.keys(op.request.headers||{}))if(/^(cookie|authorization|proxy-authorization)$/i.test(name))fail(`${op.id}: hardcoded auth header`);
 for(const evidence of op.provenance.evidence||[])if(!fs.existsSync(path.join(root,evidence)))fail(`${op.id}: missing evidence ${evidence}`);
 if(op.status==='verified'&&!op.provenance.verifiedAt)fail(`${op.id}: verified date required`);checks++;}
for(const service of services.values())if(service.auth.identityProbeOperation&&!operations.some(o=>o.id===service.auth.identityProbeOperation&&o.semantics==='read'))fail(`${service.id}: identity probe missing or not read-only`);
const ipc=schemas.get('ipc.schema.json');const snap=jsons.get(path.join(root,'examples/messages/snapshot-response.json'));
if(ipc&&snap){for(const e of validate(snap.result,ipc.$defs.snapshotResult,ipc))fail(`snapshot response: ${e}`);for(const c of snap.result.cookies)if(c.value!=='EXAMPLE_NOT_A_REAL_CREDENTIAL')fail('Cookie example contains a non-placeholder value');checks++;}
// Negative fixtures ensure the checker actually rejects important invalid contracts.
const base=jsons.get(path.join(root,'examples/operations/risk-api.auto-interfaces.list.json'));
const negative=[];if(base){let x=structuredClone(base);x.request.method='TRACE';negative.push(['invalid method',x,schemas.get('operation.schema.json')]);x=structuredClone(base);x.unknownField=true;negative.push(['unknown field',x,schemas.get('operation.schema.json')]);}
negative.push(['missing error',{schemaVersion:1,requestId:'x',ok:false,meta:{}},schemas.get('tool-result.schema.json')]);
negative.push(['missing snapshot scope',{schemaVersion:1,requestId:'x',type:'request',method:'cookies.snapshot',params:{}},ipc]);
for(const[name,data,s]of negative){if(s&&validate(data,s).length===0)fail(`Negative fixture accepted: ${name}`);checks++;}
if(operations.some(o=>o.request.path.includes('getPageInterIdList')))fail('Unverified getPageInterIdList must not be an executable example');
const packageData=jsons.get(path.join(root,'package.json'));if(packageData?.bin?.intra&&!fs.existsSync(path.join(root,'apps/cli/src/main.ts')))fail('Runtime CLI entry source is missing');
if(errors.length){console.error(JSON.stringify({ok:false,checks,errors},null,2));process.exit(1);}
console.log(JSON.stringify({ok:true,checks,markdownFiles:files.filter(p=>p.endsWith('.md')).length,jsonFiles:jsons.size,schemas:schemas.size,examples:index.examples.length,operations:operations.length,negativeFixtures:negative.length,scope:'offline documentation, links, supported Schema subset and example semantics; no network or credentials'},null,2));
