window.onload=changeStyle;

function changeStyle(){
		var div1=document.getElementById("div1");
		div1.onmouseover=function(){
				div1.className="div2";
		}
		div1.onmouseout=function(){
				div1.className="";
		}
}
