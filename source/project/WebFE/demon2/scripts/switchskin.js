window.onload=switchskin;

function switchskin(){
		var skins=document.getElementsByClassName("skin");
		var source=document.getElementById("skincss");
		for(var i=0;i<skins.length;i++){
				if(skins[i].getAttribute("name")=="red"){
						skins[i].onclick=function(){
								source.setAttribute("href","styles/red.css");
						}
				}
				if(skins[i].getAttribute("name")=="green"){
						skins[i].onclick=function(){
								source.setAttribute("href","styles/green.css");
						}
				}
				if(skins[i].getAttribute("name")=="black"){
						skins[i].onclick=function(){
								source.setAttribute("href","styles/black.css");
						}
				}
				
		}
}
