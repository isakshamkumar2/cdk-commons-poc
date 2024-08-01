import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as autoscaling from 'aws-cdk-lib/aws-autoscaling';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import { Construct } from 'constructs';
import * as path from 'path';
import * as fs from 'fs';

export class CdkAppStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Create a VPC without NAT Gateways
    const vpc = new ec2.Vpc(this, 'MyVPC', {
      maxAzs: 2,
      natGateways: 0,
      subnetConfiguration: [
        {
          cidrMask: 24,
          name: 'Public',
          subnetType: ec2.SubnetType.PUBLIC,
        }
      ]
    });

    // Create a security group
    const securityGroup = new ec2.SecurityGroup(this, 'MySecurityGroup', {
      vpc,
      description: 'Allow HTTP traffic',
      allowAllOutbound: true
    });

    // Allow inbound traffic on ports 80 and 5000
    securityGroup.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(80), 'Allow HTTP traffic');
    securityGroup.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(5000), 'Allow Flask app traffic');

    // Create an IAM role for the EC2 instance
    const role = new iam.Role(this, 'EC2Role', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com')
    });
    
    role.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'));
    
    // Read the contents of your Flask app
    const flaskAppPath = path.join(__dirname, '..', '..', 'flask-app');
    const appPyContent = fs.readFileSync(path.join(flaskAppPath, 'app.py'), 'utf8');
    const requirementsContent = fs.readFileSync(path.join(flaskAppPath, 'requirements.txt'), 'utf8');
    
    // User data script to set up and run Flask app
    const userData = ec2.UserData.forLinux();
    userData.addCommands(
      'sudo yum update -y',
      'sudo yum install -y python3 python3-pip',
      'mkdir -p /home/ec2-user/flask-app',
      `echo '${appPyContent}' > /home/ec2-user/flask-app/app.py`,
      `echo '${requirementsContent}' > /home/ec2-user/flask-app/requirements.txt`,
      'cd /home/ec2-user/flask-app',
      'pip3 install -r requirements.txt',
      'python3 app.py &'
    );
    
    // Create an Auto Scaling Group
    const autoScalingGroup = new autoscaling.AutoScalingGroup(this, 'MyASG', {
      vpc,
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T2, ec2.InstanceSize.MICRO),
      machineImage: ec2.MachineImage.latestAmazonLinux2(),
      userData,
      minCapacity: 1,
      maxCapacity: 1,
      desiredCapacity: 1,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      securityGroup
    });

    // Create an Application Load Balancer
    const lb = new elbv2.ApplicationLoadBalancer(this, 'MyALB', {
      vpc,
      internetFacing: true
    });

    // Add a listener to the load balancer
    const listener = lb.addListener('MyListener', { port: 80 });

    // Add the Auto Scaling Group as a target to the listener
    listener.addTargets('MyFlaskApp', {
      port: 5000,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targets: [autoScalingGroup],
      healthCheck: {
        path: '/',
        unhealthyThresholdCount: 2,
        healthyThresholdCount: 5,
        interval: cdk.Duration.seconds(30),
      },
    });

    // Output the load balancer DNS name
    new cdk.CfnOutput(this, 'LoadBalancerDNS', {
      value: lb.loadBalancerDnsName
    });
  }
}