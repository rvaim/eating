import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createImageFixturePng } from './image'
export const adbFixturePng = createImageFixturePng()
/** An executable protocol fixture. It never discovers or connects real devices. */
export async function writeAdbFixture(directory: string): Promise<string> {
  const file = join(directory, 'fixture-adb.mjs')
  await writeFile(file, `#!${process.execPath}
const args=process.argv.slice(2);
if(args[0]==='version'){console.log('Android Debug Bridge fixture version');process.exit(0)}
if(args[0]==='utf8-boundary'){process.stdout.write(Buffer.concat([Buffer.alloc(16383,97),Buffer.from('你🙂end')]));process.exit(0)}
if(args.includes('screencap')){process.stdout.write(Buffer.from('${adbFixturePng.toString('base64')}','base64'));process.exit(0)}
if(args[0]==='hold'||args[0]==='logcat'){
 console.log('READY');const timer=setInterval(()=>{},1000);
 process.stdin.on('data',data=>process.stdout.write('INPUT:'+data));
 process.stdin.on('end',()=>{clearInterval(timer);process.exit(0)});
}else{console.log(JSON.stringify(args));}
`, { mode: 0o700 })
  return file
}
