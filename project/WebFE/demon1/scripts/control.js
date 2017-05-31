window.onload=function(){
		setting();
		control();
}

function setting(){
		var div1=document.getElementById("div1");
		div1.style.width="200px";
		div1.style.height="200px";
		div1.style.backgroundColor="#ffffff";
}

function control(){
		//if(!document.getAttribute) return false;
		//if(!document.getElementsByTagName) return false;
		var bts=document.getElementsByTagName("input");
		var div1=document.getElementById("div1");
		for(var i=0;i