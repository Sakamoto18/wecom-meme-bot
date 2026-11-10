param(
    [ValidateSet('on','off')][string]$Mode = 'off',
    [string]$AstrBotRoot = 'C:\AstrBot'
)
$ErrorActionPreference = 'Stop'
$python = Join-Path $AstrBotRoot '.venv\Scripts\python.exe'
$env:LONGTU_TRIAL_MODE = $Mode
$env:LONGTU_ASTRBOT_ROOT = $AstrBotRoot
# Change only our official entry. Never disable/change the OneBot platform.
@'
import json, os, pathlib, shutil, datetime
root=pathlib.Path(os.environ['LONGTU_ASTRBOT_ROOT'])
main=root/'data/cmd_config.json'
plugin=root/'data/config/astrbot_plugin_longtu_bridge_config.json'
config=json.loads(main.read_text(encoding='utf-8-sig'))
bridge=json.loads(plugin.read_text(encoding='utf-8-sig'))
official=[x for x in config.get('platform',[]) if x.get('id')=='longtu-official-trial']
if len(official)!=1 or str(official[0].get('appid'))!='1903660238':
    raise SystemExit('Official trial platform not configured; nothing changed')
on=os.environ['LONGTU_TRIAL_MODE']=='on'
if on and not official[0].get('secret'): raise SystemExit('Official secret missing')
backup=root/'data/official-trial-backups'/datetime.datetime.now().strftime('%Y%m%d-%H%M%S-%f')
backup.mkdir(parents=True)
shutil.copy2(main,backup/'cmd_config.json')
shutil.copy2(plugin,backup/'bridge_config.json')
official[0]['enable']=on
bridge['official_trial_enabled']=on
for path,data in [(main,config),(plugin,bridge)]:
    temporary=path.with_suffix('.official-tmp')
    temporary.write_text(json.dumps(data,ensure_ascii=False,indent=2),encoding='utf-8')
    temporary.replace(path)
print('OFFICIAL_TRIAL='+('ON' if on else 'OFF')+'; OneBot configuration preserved')
'@ | & $python -X utf8 -
if ($LASTEXITCODE -ne 0) { throw 'Trial toggle failed' }
Stop-ScheduledTask -TaskName Longtu-AstrBot
$deadline=(Get-Date).AddSeconds(45)
while(Get-NetTCPConnection -LocalPort 6199 -State Listen -ErrorAction SilentlyContinue){
    if((Get-Date) -gt $deadline){throw 'AstrBot did not stop; configuration saved, restart required'}
    Start-Sleep 1
}
Start-ScheduledTask -TaskName Longtu-AstrBot
Write-Output "Trial $Mode saved; AstrBot restarting. NapCat and Backend were not restarted."
