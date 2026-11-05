"""Optional audio recorded from the playing tab, without fetching media URLs."""
import asyncio
import base64
import json
import os
import tempfile
from pathlib import Path

START_AUDIO = """async () => {
 const v = document.querySelector('video, bwp-video');
 try {
   const ctx = new AudioContext({sampleRate: 16000});
   await ctx.resume();
   const source = ctx.createMediaElementSource(v);
   const processor = ctx.createScriptProcessor(4096, 1, 1);
   const parts = [];
   processor.onaudioprocess = e => parts.push(new Float32Array(e.inputBuffer.getChannelData(0)));
   source.connect(processor); processor.connect(ctx.destination);
   v.muted = false;
   window.__learningAudio = {ctx, source, processor, parts};
   return {ok: true};
 } catch(e) {return {ok: false, error: String(e).slice(0,150)};}
}"""
STOP_AUDIO = """async () => {
 const a = window.__learningAudio;
 if (!a) return null;
 a.processor.disconnect(); a.source.disconnect(); await a.ctx.close();
 const n = a.parts.reduce((sum,p) => sum + p.length, 0);
 if (!n) return null;
 const buffer = new ArrayBuffer(44 + n*2), view = new DataView(buffer);
 const str = (offset,s) => [...s].forEach((c,i) => view.setUint8(offset+i,c.charCodeAt(0)));
 str(0,'RIFF');view.setUint32(4,36+n*2,true);str(8,'WAVE');str(12,'fmt ');
 view.setUint32(16,16,true);view.setUint16(20,1,true);view.setUint16(22,1,true);
 view.setUint32(24,a.ctx.sampleRate,true);view.setUint32(28,a.ctx.sampleRate*2,true);
 view.setUint16(32,2,true);view.setUint16(34,16,true);str(36,'data');view.setUint32(40,n*2,true);
 let offset=44, peak=0;
 for(const p of a.parts) for(const s of p){peak=Math.max(peak,Math.abs(s));view.setInt16(offset,Math.max(-1,Math.min(1,s))*32767,true);offset+=2;}
 if(peak<0.0001) return null;
 const bytes = new Uint8Array(buffer); let binary='';
 for(let i=0;i<bytes.length;i+=8192)binary+=String.fromCharCode(...bytes.subarray(i,i+8192));
 delete window.__learningAudio;
 return btoa(binary);
}"""


async def transcribe_recording(page, start):
    if not start.get('ok'):
        return {'status': 'unavailable', 'error': '本次未学习音频：网页音频录制不可用', 'transcript': []}
    process = None
    try:
        encoded = await asyncio.wait_for(page.evaluate(STOP_AUDIO), 10)
        if not encoded:
            raise ValueError('网页没有返回可用音频')
        python = os.getenv('QQ_VIDEO_LEARNING_ASR_PYTHON', '').strip()
        if not python:
            raise ValueError('未配置音频转写')
        with tempfile.TemporaryDirectory(prefix='browser-learning-audio-') as directory:
            audio = Path(directory) / 'audio.wav'
            audio.write_bytes(base64.b64decode(encoded))
            script = Path(__file__).resolve().parents[2] / 'scripts' / 'asr_transcribe.py'
            env = dict(os.environ, ASR_MODEL=os.getenv('QQ_VIDEO_LEARNING_ASR_MODEL', 'small'))
            process = await asyncio.create_subprocess_exec(python, str(script), str(audio),
                stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE, env=env)
            try:
                output, _ = await asyncio.wait_for(process.communicate(), 90)
            finally:
                if process.returncode is None:
                    if os.name == 'nt':
                        killer = await asyncio.create_subprocess_exec('taskkill', '/PID', str(process.pid), '/T', '/F',
                            stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL)
                        await killer.wait()
                    else:
                        process.kill()
                    await process.wait()
            if process.returncode != 0:
                raise ValueError('音频转写进程失败')
            rows = json.loads(output)
            if not rows:
                raise ValueError('未识别到语音')
            return {'status': 'transcribed', 'transcript': rows, 'method': 'browser-web-audio'}
    except Exception as error:
        return {'status': 'unavailable', 'error': '本次未学习音频：' + (str(error) or type(error).__name__)[:160], 'transcript': []}
