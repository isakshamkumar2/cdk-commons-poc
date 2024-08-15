import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import { Construct } from 'constructs';
import * as path from 'path';
import * as fs from 'fs';
import {
  createDefaultVpc, STAGES, createDefaultSecurityGroup, createIAMRole,
  attachManagedPolicyToRole, MANAGED_POLICIES, createPolicyStatement,
  attachCustomPolicyStatementsToRole, createS3Bucket, deployToS3Bucket,
  createLoadBalancerWithTargets, createDefaultAutoScalingGroup
} from '@genflowly/cdk-commons';

export class CdkAppStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const vpc = createDefaultVpc('MyVpc', 'FlaskAppVPC', 2, this, STAGES.BETA, true);

    const securityGroup = createDefaultSecurityGroup(
      'MySecurityGroup',
      vpc,
      'Security group for Flask app',
      STAGES.BETA,
      this,
    );

    securityGroup.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(80), 'Allow HTTP traffic');
    securityGroup.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(5000), 'Allow Flask app traffic');
    securityGroup.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(22), 'Allow SSH access');

    const role = createIAMRole(
      'EC2Role',
      new iam.ServicePrincipal('ec2.amazonaws.com'),
      STAGES.BETA,
      this
    );
    
    attachManagedPolicyToRole(role, MANAGED_POLICIES.SSM_MANAGED_INSTANCE_CORE);

    const wheelsBucket = createS3Bucket(this, {
      bucketName: `flaskappwheels-${STAGES.BETA}`,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      stage: STAGES.BETA,
      autoDeleteObjects: true
    });

    const s3PolicyStatement = createPolicyStatement(
      ['s3:ListBucket', 's3:GetObject', 's3:PutObject', 's3:DeleteObject'],
      [wheelsBucket.bucketArn, `${wheelsBucket.bucketArn}/*`]
    );
    attachCustomPolicyStatementsToRole(role, [s3PolicyStatement]);

    const s3Deployment = deployToS3Bucket(this, {
      deploymentName: 'DeployWheels',
      destinationBucket: wheelsBucket,
      sourcePath: path.join(__dirname, '..', '..', 'flask-app', 'wheels'),
      stage: STAGES.BETA,
      destinationKeyPrefix: 'wheels'
    });

    const flaskAppPath = path.join(__dirname, '..', '..', 'flask-app');
    const appPyContent = fs.readFileSync(path.join(flaskAppPath, 'app.py'), 'utf8');
    const wsgiPyContent = fs.readFileSync(path.join(flaskAppPath, 'wsgi.py'), 'utf8');

    const userData = ec2.UserData.forLinux();
    userData.addCommands(
      '#!/bin/bash',
      'set -e',
      'yum update -y',
      'yum install -y python3 python3-pip awscli',
      'mkdir -p /home/ec2-user/flask-app/wheels',
      `echo '${appPyContent.replace(/'/g, "'\\''")}' > /home/ec2-user/flask-app/app.py`,
      `echo '${wsgiPyContent.replace(/'/g, "'\\''")}' > /home/ec2-user/flask-app/wsgi.py`,
      `aws s3 cp s3://${wheelsBucket.bucketName}/wheels/ /home/ec2-user/flask-app/wheels/ --recursive`,
      'cd /home/ec2-user/flask-app',
      'pip3 install flask gunicorn',
      'pip3 install wheels/*.whl',
      'nohup gunicorn --workers 3 --bind 0.0.0.0:5000 wsgi:app > /dev/null 2>&1 &'
    );

    const autoScalingGroup = createDefaultAutoScalingGroup(this, {
      asgName: 'MyASG',
      vpc,
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T2, ec2.InstanceSize.MICRO),
      machineImage: ec2.MachineImage.latestAmazonLinux2(),
      userData,
      minCapacity: 1,
      maxCapacity: 1,
      desiredCapacity: 1,
      subnetType: ec2.SubnetType.PUBLIC,
      stage: STAGES.BETA,
      keyName: 'flaskapp',
      securityGroup,
      role
    });

    autoScalingGroup.node.addDependency(s3Deployment);

    const { loadBalancer } = createLoadBalancerWithTargets(this, {
      lbName: 'MyALB',
      vpc,
      stage: STAGES.BETA,
      internetFacing: true,
      listenerPort: 80,
      targetGroups: [{
        name: 'MyFlaskApp',
        port: 5000,
        targets: [autoScalingGroup],
        healthCheckPath: '/',
        protocol: elbv2.ApplicationProtocol.HTTP,
      }]
    });

    new cdk.CfnOutput(this, 'LoadBalancerDNS', {
      value: loadBalancer.loadBalancerDnsName
    });
  }
}