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
		for(var i=0;i<bts.length;i++){

				if(bts[i].getAttribute("name")=="button1"){
						bts[i].onclick=function(){
								div1.style.width="400px";
						}
					}
				if(bts[i].getAttribute("name")=="button2"){
					bts[i].onclick=function(){
								div1.style.height="400px";
						}
					}
				if(bts[i].getAttribute("name")=="button3"){
						bts[i].onclick=function(){
								div1.style.backgroundColor="#ffff00";
						}
				}
				if(bts[i].getAttribute("name")=="button4"){
						bts[i].onclick=function(){
								div1.style.backgroundColor="#444444";
						}
				}
				if(bts[i].getAttribute("name")=="button5"){
						bts[i].onclick=function(){
								div1.style.width="200px";
								div1.style.height="200px";
								div1.style.backgroundColor="#ffffff"
						}
				}
		}
}
