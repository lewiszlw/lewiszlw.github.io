window.onload=switchColor;

function switchColor(){
		var bt=document.getElementsByTagName("input");
		var divs=document.getElementById("contain").getElementsByTagName("div");
		bt[0].onclick=function(){
				for(var i=0;i<divs.length;i++){
						divs[i].style.backgroundColor="red";
				}
		}
}
