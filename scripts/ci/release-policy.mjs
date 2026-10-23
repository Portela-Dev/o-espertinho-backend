import {execFileSync} from 'node:child_process';
import {readFileSync,appendFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

const tagPrefix='refs/tags/v';
const git=args=>execFileSync('git',args,{encoding:'utf8',windowsHide:true}).trim();
export function verifyMainRelease({eventName,ref,sha,event},runGit=git){
 if(eventName!=='push'||!ref?.startsWith(tagPrefix))return false;
 if(!/^refs\/tags\/v\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(ref))throw new Error('Use uma tag vMAJOR.MINOR.PATCH.');
 if(event.created!==true||event.deleted===true||event.forced===true)throw new Error('Somente a criação de uma nova tag permite deploy.');
 if(event.ref!==ref||!/^[a-f0-9]{40}$/.test(sha))throw new Error('Evento de tag inconsistente.');
 const commit=runGit(['rev-parse','--verify',ref+'^{commit}']);
 if(commit!==sha||runGit(['rev-parse','HEAD'])!==commit)throw new Error('Checkout ou tag não corresponde ao commit validado.');
 if(runGit(['rev-parse','--verify','refs/remotes/origin/main^{commit}'])!==commit)throw new Error('A tag deve apontar exatamente para o HEAD atual de main.');
 return true;
}
export function releasePolicy(env=process.env,args=process.argv.slice(2),runGit=git){
 if(args.some(arg=>arg!=='--require-deploy'))throw new Error('Argumento de release inválido.');
 const event=JSON.parse(readFileSync(env.GITHUB_EVENT_PATH,'utf8'));
 if(env.GITHUB_EVENT_NAME==='push'&&env.GITHUB_REF?.startsWith(tagPrefix))runGit(['fetch','--no-tags','origin','+refs/heads/main:refs/remotes/origin/main']);
 const deploy=verifyMainRelease({eventName:env.GITHUB_EVENT_NAME,ref:env.GITHUB_REF,sha:env.GITHUB_SHA,event},runGit);
 if(args.includes('--require-deploy')&&!deploy)throw new Error('Deploy recusado: exige criação de tag v* no HEAD de main.');
 if(env.GITHUB_OUTPUT)appendFileSync(env.GITHUB_OUTPUT,'deploy='+deploy+'\n');
 console.log(deploy?'Release main autorizada.':'Somente CI; nenhum deploy autorizado.');
 return deploy;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 try{releasePolicy();}catch(error){console.error(error.message);process.exitCode=1;}
}
