window.onload=sendMessage;

function sendMessage(){
		var texts=document.getElementsByTagName("input");
		var bt=document.getElementById("send");
		bt.onclick=function(){
				show(texts[0].value,texts[1].value);
		}
}
function show(a,b){
		alert(a);
		alert(b);
}
