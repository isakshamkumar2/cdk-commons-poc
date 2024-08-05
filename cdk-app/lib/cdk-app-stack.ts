import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as autoscaling from 'aws-cdk-lib/aws-autoscaling';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import { Construct } from 'constructs';
import * as path from 'path';
import * as fs from 'fs';
import { createDefaultVpc, STAGES, createDefaultSecurityGroup, createIAMRole, attachManagedPolicyToRole, MANAGED_POLICIES } from "@isakshamkumar2/cdk-common-test"

export class CdkAppStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // VPC creation
    const vpc = createDefaultVpc('MyVpc', 'FlaskAppVPC', 2, this, STAGES.BETA, true);

    // Security group creation
    const securityGroup = createDefaultSecurityGroup(
      'MySecurityGroup',                
      'FlaskAppSG',                     
      vpc,                             
      'Security group for Flask app',   
      STAGES.BETA,                      
      this                             
    );

    // Allow inbound traffic on ports 80, 5000, and 22
    securityGroup.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(80), 'Allow HTTP traffic');
    securityGroup.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(5000), 'Allow Flask app traffic');
    securityGroup.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(22), 'Allow SSH access');

    // IAM role creation
    const role = createIAMRole(
      'EC2Role',                                
      'MyEC2Role',                               
      new iam.ServicePrincipal('ec2.amazonaws.com'),
      STAGES.BETA,                               
      this                                        
    );
    
    attachManagedPolicyToRole(role, MANAGED_POLICIES.SSM_MANAGED_INSTANCE_CORE);

    // Create S3 bucket for wheel files
    const wheelsBucket = new s3.Bucket(this, 'WheelsBucket', {
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    // Upload wheel files to S3 bucket
    new s3deploy.BucketDeployment(this, 'DeployWheels', {
      sources: [s3deploy.Source.asset(path.join(__dirname, '..', '..', 'flask-app', 'wheels'))],
      destinationBucket: wheelsBucket,
      destinationKeyPrefix: 'wheels',
    });

    // Grant read access to the EC2 instances
    wheelsBucket.grantRead(role);

    // Read Flask app contents
    const flaskAppPath = path.join(__dirname, '..', '..', 'flask-app');
    const appPyContent = fs.readFileSync(path.join(flaskAppPath, 'app.py'), 'utf8');
    const wsgiPyContent = fs.readFileSync(path.join(flaskAppPath, 'wsgi.py'), 'utf8');

    const userData = ec2.UserData.forLinux();
    userData.addCommands(
      '#!/bin/bash',
      'set -e',
      'sudo yum update -y',
      'sudo yum install -y python3 python3-pip awscli',
      'mkdir -p /home/ec2-user/flask-app/wheels',
      
      // Create Flask app files
      `echo '${appPyContent.replace(/'/g, "'\\''")}' > /home/ec2-user/flask-app/app.py`,
      `echo '${wsgiPyContent.replace(/'/g, "'\\''")}' > /home/ec2-user/flask-app/wsgi.py`,
      
      // Download wheel files from S3
      `aws s3 cp s3://${wheelsBucket.bucketName}/wheels/ /home/ec2-user/flask-app/wheels/ --recursive`,
      
      'cd /home/ec2-user/flask-app',
      
      // Install wheel files
      'pip3 install wheels/*.whl',
      
      // Start Flask app with Gunicorn
      'nohup gunicorn --workers 3 --bind 0.0.0.0:5000 wsgi:app > flask.log 2>&1 &',
      
      // Ensure the app started successfully
      'sleep 5',
      'if ! pgrep gunicorn > /dev/null; then',
      '  echo "Gunicorn failed to start" >&2',
      '  exit 1',
      'fi',
      
      'echo "Flask app deployed successfully"'
    );

    
    // Auto Scaling Group creation
    const autoScalingGroup = new autoscaling.AutoScalingGroup(this, 'MyASG', {
      vpc,
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T2, ec2.InstanceSize.MICRO),
      machineImage: ec2.MachineImage.latestAmazonLinux2(),
      userData,
      minCapacity: 1,
      maxCapacity: 1,
      keyName:'flaskapp',
      desiredCapacity: 1,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      securityGroup,
      associatePublicIpAddress:true
    });

    // Application Load Balancer creation
    const lb = new elbv2.ApplicationLoadBalancer(this, 'MyALB', {
      vpc,
      internetFacing: true
    });

    // Add listener to the load balancer
    const listener = lb.addListener('MyListener', { port: 80 });

    // Add the Auto Scaling Group as a target to the listener
    listener.addTargets('MyFlaskApp', {
      port: 5000,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targets: [autoScalingGroup],
      healthCheck: {
        path: '/',
        unhealthyThresholdCount: 2,
        healthyThresholdCount: 2,
        interval: cdk.Duration.seconds(15),
        timeout: cdk.Duration.seconds(10),
      },
    });

    // Output the load balancer DNS name
    new cdk.CfnOutput(this, 'LoadBalancerDNS', {
      value: lb.loadBalancerDnsName
    });
  }
}