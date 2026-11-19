// View-only grouping. The editable clips, paint order and export tracks are never rewritten.
export function graphicGroups(project) {
  const groups=new Map();
  for(const track of project.tracks){
    const clips=project.clips.filter(c=>c.track===track);
    if(!clips.length||!clips.every(c=>c.effect?.type==='live_graphic'))continue;
    const name=(project.trackLabels?.[track]||'Graphics').replace(/\s+\d+$/,'');
    if(!groups.has(name))groups.set(name,{name,tracks:[],clips:[]});
    const group=groups.get(name);group.tracks.push(track);group.clips.push(...clips);
  }
  return [...groups.values()];
}
export function timelineRows(project,expanded=new Set()){
  const groups=graphicGroups(project),graphicTracks=new Set(groups.flatMap(g=>g.tracks));
  const rows=[];
  if(groups.length){
    rows.push({kind:'graphics',key:'graphics',name:'Graphics',clips:groups.flatMap(g=>g.clips),groups});
    if(expanded.has('graphics'))for(const group of groups){
      rows.push({kind:'group',key:`graphics:${group.name}`,name:group.name,...group});
      if(expanded.has(`graphics:${group.name}`))for(const track of group.tracks)rows.push({kind:'track',track});
    }
  }
  for(const track of project.tracks)if(!graphicTracks.has(track)&&project.clips.some(c=>c.track===track))rows.push({kind:'track',track});
  return rows;
}
