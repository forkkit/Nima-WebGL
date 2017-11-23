import ActorComponent from "./ActorComponent.js";
import ActorJellyBone from "./ActorJellyBone.js";
import { mat2d, vec2 } from "gl-matrix";

// https://stackoverflow.com/questions/1734745/how-to-create-circle-with-b%C3%A9zier-curves
const JellyMax = 16;
const OptimalDistance = 4*(Math.sqrt(2)-1)/3;
const CurveConstant = OptimalDistance * Math.sqrt(2) * 0.5;

function ForwardDiffBezier(c0, c1, c2, c3, points, count, offset)
{
	let f = count;

	let p0 = c0;

	let p1 = 3.0 * (c1 - c0) / f;

	f *= count;
	let p2 = 3.0 * (c0 - 2.0 * c1 + c2) / f;
	
	f *= count;
	let p3 = (c3 - c0 + 3.0 * (c1 - c2)) / f;

	c0 = p0;
	c1 = p1 + p2 + p3;
	c2 = 2 * p2 + 6 * p3;
	c3 = 6 * p3;

	for (let a = 0; a <= count; a++) 
	{
		points[a][offset] = c0;
		c0 += c1;
		c1 += c2;
		c2 += c3;
	}
}

function NormalizeCurve(curve, numSegments)
{
	let points = [];
	let curvePointCount = curve.length;
	let distances = new Float32Array(curvePointCount);
	distances[0] = 0;
	for(let i = 0; i < curvePointCount-1; i++)
	{
		let p1 = curve[i];
		let p2 = curve[i+1];
		distances[i + 1] = distances[i] + vec2.distance(p1, p2);
	}
	let totalDistance = distances[curvePointCount-1];

	let segmentLength = totalDistance/numSegments;
	let pointIndex = 1;
	for(let i = 1; i <= numSegments; i++)
	{
		let distance = segmentLength * i;

		while(pointIndex < curvePointCount-1 && distances[pointIndex] < distance)
		{
			pointIndex++;
		}

		let d = distances[pointIndex];
		let lastCurveSegmentLength = d - distances[pointIndex-1];
		let remainderOfDesired = d - distance;
		let ratio = remainderOfDesired / lastCurveSegmentLength;
		let iratio = 1.0-ratio;

		let p1 = curve[pointIndex-1];
		let p2 = curve[pointIndex];
		points.push([p1[0]*ratio+p2[0]*iratio, p1[1]*ratio+p2[1]*iratio]);
	}

	return points;
}

let EPSILON = 0.001; // Intentionally aggressive.

function FuzzyEquals(a, b) 
{
    var a0 = a[0], a1 = a[1];
    var b0 = b[0], b1 = b[1];
    return (Math.abs(a0 - b0) <= EPSILON*Math.max(1.0, Math.abs(a0), Math.abs(b0)) &&
            Math.abs(a1 - b1) <= EPSILON*Math.max(1.0, Math.abs(a1), Math.abs(b1)));
}

export default class JellyComponent extends ActorComponent
{
	constructor()
	{
		super();

		this._EaseIn = 0.0;
		this._EaseOut = 0.0;
		this._ScaleIn = 0.0;
		this._ScaleOut = 0.0;
		this._InTargetIdx = 0;
		this._OutTargetIdx = 0;
		this._InTarget = null;
		this._OutTarget = null;

		this._Bones = [];
		this._InPoint = vec2.create();
		this._InDirection = vec2.create();
		this._OutPoint = vec2.create();
		this._OutDirection = vec2.create();
	}

	makeInstance(resetActor)
	{
		var node = new JellyComponent();
		node.copy(this, resetActor);
		return node;	
	}

	copy(node, resetActor)
	{
		super.copy(node, resetActor);
		this._EaseIn = node._EaseIn;
		this._EaseOut = node._EaseOut;
		this._ScaleIn = node._ScaleIn;
		this._ScaleOut = node._ScaleOut;
		this._InTargetIdx = node._InTargetIdx;
		this._OutTargetIdx = node._OutTargetIdx;
	}

	resolveComponentIndices(components)
	{
		super.resolveComponentIndices(components);

		if(this._InTargetIdx !== 0)
		{
			this._InTarget = components[this._InTargetIdx];
		}
		if(this._OutTargetIdx !== 0)
		{
			this._OutTarget = components[this._OutTargetIdx];
		}
	}

	completeResolve()
	{
		let bone = this._Parent;
		bone._Jelly = this;

		// Get jellies.
		let children = bone._Children;
		if(!children)
		{
			return;
		}
		for(let child of children)
		{
			if(child.constructor === ActorJellyBone)
			{
				this._Bones.push(child);
			}
		}
	}

	updateJellies()
	{
		let bone = this._Parent;
		// We are in local bone space.
		let tipPosition = vec2.set(vec2.create(), bone._Length, 0.0);
		let jc = this._Cache;

		let jellies = this._Bones;
		if(!jellies)
		{
			return;
		}

		if(jc && jc.count === jellies.length && FuzzyEquals(jc.tip, tipPosition) && FuzzyEquals(jc.out, this._OutPoint) && FuzzyEquals(jc.in, this._InPoint) && jc.sin === this._ScaleIn && jc.sout === this._ScaleOut)
		{
			return;
		}

		this._Cache =
		{
			count:jellies.length,
			tip:tipPosition,
			out:vec2.clone(this._OutPoint),
			in:vec2.clone(this._InPoint),
			sin:this._ScaleIn,
			sout:this._ScaleOut
		};

		let q0 = vec2.create();
		let q1 = this._InPoint;
		let q2 = this._OutPoint;
		let q3 = tipPosition;


		var subdivisions = JellyMax;
		var points = [];
		for(var i = 0; i <= subdivisions; i++)
		{
			points.push(new Float32Array(2));
		}

		ForwardDiffBezier(q0[0], q1[0], q2[0], q3[0], points, subdivisions, 0);
		ForwardDiffBezier(q0[1], q1[1], q2[1], q3[1], points, subdivisions, 1);

		let normalizedPoints = NormalizeCurve(points, jellies.length);

		var lastPoint = points[0];

		let scale = this._ScaleIn;
		let scaleInc = (this._ScaleOut - this._ScaleIn)/(jellies.length-1);
		for(let i = 0; i < normalizedPoints.length; i++)
		{
			let jelly = jellies[i];
			var p = normalizedPoints[i];

			// We could set these by component and allow the mark to happen only if things have changed
			// but it's really likely that we have to mark dirty here, so might as well optimize the general case.
			vec2.copy(jelly._Translation, lastPoint);
			jelly._Length = vec2.distance(p, lastPoint);
			jelly._Scale[1] = scale;
			scale += scaleInc;

			let diff = vec2.subtract(vec2.create(), p, lastPoint);
			jelly._Rotation = Math.atan2(diff[1], diff[0]);
			jelly.markTransformDirty();
			lastPoint = p;
		}
	}

	get tipPosition()
	{
		let bone = this._Parent;
		return vec2.set(vec2.create(), bone._Length, 0.0);
	}

	setOutDirection(dir)
	{
		let bone = this._Parent;
		let length = this._EaseOut*bone._Length*CurveConstant;

		let outDir = vec2.normalize(this._OutDirection, dir);
		outDir = vec2.scale(vec2.create(), outDir, length);
		let tipPosition = this.tipPosition;

		vec2.add(this._OutPoint, tipPosition, outDir);

		this.updateJellies();
	}

	updateInPoint()
	{
		let bone = this._Parent;
		let parentBone = bone._Parent;
		let parentBoneJelly = parentBone && parentBone._Jelly;

		if(!bone)
		{
			return;
		}
		let length = this._EaseIn*bone._Length*CurveConstant;
		if(this._InTarget)
		{
			let translation = this._InTarget.worldTranslation;
			let inverseWorld = mat2d.invert(mat2d.create(), bone._WorldTransform);
			if(!inverseWorld)
			{
				console.warn("Failed to invert transform space", bone._WorldTransform);
				return;
			}
			vec2.transformMat2d(this._InPoint, translation, inverseWorld);
			vec2.normalize(this._InDirection, this._InPoint);

			if(parentBone && parentBone._FirstBone === bone)
			{
				if(parentBoneJelly.outTarget)
				{
					let translation = parentBoneJelly.outTarget.worldTranslation;
					let parentInverseWorld = mat2d.invert(mat2d.create(), parentBone._WorldTransform);
					if(!parentInverseWorld)
					{
						console.warn("Failed to invert transform space", parentBone._WorldTransform);
						return;
					}
					vec2.transformMat2d(parentBoneJelly._OutPoint, translation, parentInverseWorld);
					vec2.normalize(parentBoneJelly._OutDirection, parentBoneJelly._OutPoint);
					parentBoneJelly.updateJellies();
				}
				else
				{
					let parentInverseWorld = mat2d.invert(mat2d.create(), parentBone._WorldTransform);
					if(!parentInverseWorld)
					{
						console.warn("Failed to invert transform space", parentBone._WorldTransform);
						return;
					}
					let worldOut = vec2.transformMat2(vec2.create(), this._InDirection, bone._WorldTransform);
					let localOut = vec2.transformMat2(vec2.create(), worldOut, parentInverseWorld);
					parentBoneJelly.setOutDirection(vec2.negate(localOut, localOut));
				}
			}
		}
		else if(parentBone && parentBone._FirstBone === bone)
		{
			if(parentBoneJelly.outTarget)
			{
				// Parent has an out target, we don't have an in target, so set our in to match the parent's out direction.

				let translation = parentBoneJelly.outTarget.worldTranslation;
				let parentInverseWorld = mat2d.invert(mat2d.create(), parentBone._WorldTransform);
				if(!parentInverseWorld)
				{
					console.warn("Failed to invert transform space", parentBone._WorldTransform);
					return;
				}
				vec2.transformMat2d(parentBoneJelly._OutPoint, translation, parentInverseWorld);
				vec2.normalize(parentBoneJelly._OutDirection, vec2.subtract(vec2.create(), parentBoneJelly._OutPoint, parentBoneJelly.tipPosition));

				let inverseWorld = mat2d.invert(mat2d.create(), bone._WorldTransform);
				if(!inverseWorld)
				{
					console.warn("Failed to invert transform space", bone._WorldTransform);
					return;
				}
				let worldOut = vec2.transformMat2(vec2.create(), parentBoneJelly._OutDirection, parentBone._WorldTransform);
				let localIn = vec2.transformMat2(vec2.create(), worldOut, inverseWorld);
				vec2.negate(localIn, localIn);

				let inDir = vec2.normalize(this._InDirection, localIn);
				inDir = vec2.scale(vec2.create(), inDir, length);

				vec2.add(this._InPoint, vec2.create(), inDir);

				parentBoneJelly.updateJellies();
			}
			else
			{
				//let parentTranslation = parent.worldTranslation;
				let inverseWorld = mat2d.invert(mat2d.create(), bone._WorldTransform);
				if(!inverseWorld)
				{
					console.warn("Failed to invert transform space", bone._WorldTransform);
					return;
				}
				let parentInverseWorld = mat2d.invert(mat2d.create(), parentBone._WorldTransform);
				if(!parentInverseWorld)
				{
					console.warn("Failed to invert transform space", parentBone._WorldTransform);
					return;
				}

				let d1 = vec2.set(vec2.create(), 1, 0);
				let d2 = vec2.set(vec2.create(), 1, 0);

				vec2.transformMat2(d1, d1, parentBone._WorldTransform);
				vec2.transformMat2(d2, d2, bone._WorldTransform);

				let sum = vec2.add(vec2.create(), d1, d2);
				vec2.normalize(sum, sum);

				let localIn = vec2.transformMat2(this._InDirection, sum, inverseWorld);
				vec2.scale(this._InPoint, localIn, length);

				let localOut = vec2.transformMat2(vec2.create(), sum, parentInverseWorld);

				parentBoneJelly.setOutDirection(vec2.negate(localOut, localOut));
			}
		}
		else
		{
			vec2.set(this._InDirection, 1, 0);
			vec2.set(this._InPoint, length, 0);
		}

		if(!bone._FirstBone)
		{
			if(this._OutTarget)
			{
				// No child bone but we have an out target
				let translation = this._OutTarget.worldTranslation;
				let inverseWorld = mat2d.invert(mat2d.create(), bone._WorldTransform);
				if(!inverseWorld)
				{
					console.warn("Failed to invert transform space", bone._WorldTransform);
					return;
				}
				vec2.transformMat2d(this._OutPoint, translation, inverseWorld);
				vec2.normalize(this._OutDirection, this._OutPoint);
				this.updateJellies();
			}
			else
			{
				this.setOutDirection(vec2.set(vec2.create(), -1, 0));
			}
		}
	}

	update(dirt)
	{
		let bone = this._Parent;

		if(bone._Jelly)
		{
			bone._Jelly.updateInPoint();
		}
	}
}