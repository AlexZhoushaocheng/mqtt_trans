import * as fs from "fs"  
import * as mqtt from 'mqtt'
import os from 'os'
import { configure, getLogger,Logger } from 'log4js'

const rosnodejs = require("rosnodejs")

const CONFIG:string = '/lxmqtt_js/conf/conf.json'

let g_logger:Logger

// 本地配置
class Config{
    private _conf_path:string = ''
    private _server_ip:string = ''
    private _server_prot:string = ''
    private _agv_id:string = ''

    get serverIp(){
        return this._server_ip
    }

    get serverPort(){
        return this._server_prot
    }

    get agvId(){
        return this._agv_id
    }

    get mqttAddr(){
        // return 'TCP://' + this._server_ip + ":" + this._server_prot
        return 'mqtt://test.mosquitto.org'
    }

    get mqttTopicReq(){
        return "/docker_json/agv" + this._agv_id + "/request";
    }

    get mqttTopicRes(){
        return "/docker_json/agv" + this._agv_id + "/response"
    }

    get confFilePath(){
        if(this._conf_path !== '' && this._conf_path !== undefined)
        {
            return this._conf_path
        }

        let ros_path:string = process.env.ROS_PACKAGE_PATH as string;
        let paths = ros_path.split(':')

        for(let path of paths)
        {
            if(path.includes('install'))
            {
                this._conf_path = path + CONFIG
                break
            }
        }

        return this._conf_path
    }

    loadConfig():boolean {
        let bRet = true
        try {
            // fs.readFile(this.confFilePath, (err, data) => {
            //     if (!err) {
            //         let j = JSON.parse(data.toString())
            //         this._server_ip = j.server_ip
            //         this._server_prot = j.server_port
            //         this._agv_id = j.agv_id

            //         console.log(j.server_ip)
            //     }
            //     else {
            //         bRet = false
            //         console.log(err)
            //     }
            // })
            g_logger.info('读取配置文件:', this.confFilePath)
            let data = fs.readFileSync(this.confFilePath)
            let j = JSON.parse(data.toString())
            this._server_ip = j.server_ip
            this._server_prot = j.server_port
            this._agv_id = j.agv_id

        }
        catch (ex) {
            bRet = false
            g_logger.error('加载配置异常:', ex)
        }

        return bRet
    }
}

class TaskResult{
    id:number = -1
    cmd:number = -1
    completed:boolean = false
    exc_code:number = -1
    raw_data:string = '' //mqtt返回原始数据

    static eExecCode = {"EXC_DOCKER_COMMUNI_ERR":37, "EXC_LOAD_TIMEOUT":38, "EXC_ROSPONSE_TIMEOUT":39 }

    reset(){
        this.id = -1
        this.cmd = -1
        this.completed = false
        this.exc_code = -1
        this.raw_data = ''
    }

    get isRunning():boolean{
        return this.id != -1 && this.completed == false
    }
}

// 转发
class Transmitter {
    constructor(){
        // this._ros_client = 
    }

    //测试
    hello(){
        console.log('hello')
    }

    //! [datas]
    _mqtt_client:mqtt.Client //mqtt 客户端
    _ros_client:any             //ros 客户端
    _ros_nh:any                 //ros nodeHandle
    _ros_pub:any                //ros publish
    _ros_sub:any                //ros subscribe
    
    _currTask:TaskResult = new TaskResult

    // _task_timer:NodeJS.Timeout
    _task_timer:number

    // 处理mqtt消息
    private onMqttMsg(topic: string, payload: Buffer, packet: mqtt.Packet){
        g_logger.trace('收到mqtt消息:', payload.toString())
        
        if(this._currTask.completed)
        {
            g_logger.warn('任务已经完成,不处理mqtt消息')
            return;
        }
        let raw_data = payload.toString()

        //校验mqtt返回的消息和当前任务是否对应
        let json_data = JSON.parse(raw_data)
        if(json_data.session_id != this._currTask.id){
            g_logger.error('mqtt 消息和当前任务id不对应,任务id:', this._currTask.id, "mqtt 消息id:", json_data.session_id)
            return
        }

        this._currTask.raw_data = raw_data
        this.exitTask()
    }

    // 处理ros消息
    private onRosMsg(msg:any){
        g_logger.trace('收到ros消息:', msg.data)

        this.execTask(msg.data)
    }

    // 初始化ros节点
    private initRos(){
        g_logger.info('初始化ros..')
        rosnodejs.initNode('js_node').then((()=>{
            this._ros_nh = rosnodejs.nh

            this._ros_pub = this._ros_nh.advertise('/json_subtask_status', 'std_msgs/String', {
				queueSize: 1,
				latching: true
            })
            
            this._ros_sub = this._ros_nh.subscribe("/json_subtask", "std_msgs/String", this.onRosMsg.bind(this))

            this._ros_pub.on('connection', ()=>{
                g_logger.info('ros节点已连接')
			});

			this._ros_pub.on('disconnect', ()=>{
				g_logger.info('ros节点已断开')
			});
        }).bind(this))
    }

    // 发布ros消息
    private rosPub(msg:any){
        g_logger.trace('ros发布消息:', msg)
        this._ros_pub.publish({data:msg})
    }

    // 初始化mqtt节点
    private initMqtt(){
        g_logger.info("初始化mqtt..\n连接mqtt服务器:" + this._config.mqttAddr + "..")
        this._mqtt_client = mqtt.connect(this._config.mqttAddr)

        this._mqtt_client.on('error',(error: Error)=>{
            g_logger.error('Mqtt 错误:', error.message)
        })

        this._mqtt_client.on('message',this.onMqttMsg)

        this._mqtt_client.on('connect',((packet:mqtt.IConnectPacket)=>{
            g_logger.info('Mqtt连接完成,订阅话题:', this._config.mqttTopicRes)
            this._mqtt_client.subscribe(this._config.mqttTopicRes,((err: Error, granted: mqtt.ISubscriptionGrant[])=>{
                if(!err)
                {
                    g_logger.info('订阅成功:', granted)
                }
                else{
                    g_logger.error('订阅失败:', err)
                }
            }).bind(this))
        }).bind(this))

        this._mqtt_client.on('close',()=>{
            g_logger.error('Mqtt 连接断开:')
        })
    }

    // 发布mqtt消息
    private mqttPub(msg:string){
        g_logger.trace('mqtt发布消息:', msg)
        this._mqtt_client.publish(this._config.mqttTopicRes, msg)
    }

    //检查当前状态是否可以执行任务(在收到ros任务消息后调用)
    private checkSelf():boolean{
        let bRet = true
        
        /******************  
        * 检查mqtt连接状态
        * 
        ******************/
        if(!this._mqtt_client.connected){
            g_logger.error('mqtt 尚未连接')
            bRet = false
        }
        return bRet
    }

    //执行任务
    private execTask(rosTaskData:string){
        //检查当前是否可以执行任务
        if(!this.checkSelf())
        {
            g_logger.error('当前状态异常,无法执行任务,退出当前任务')
            this.exitTask(TaskResult.eExecCode.EXC_DOCKER_COMMUNI_ERR)
            return
        }
    
        //重置任务状态,如果当前有任务在执行,会被覆盖,此时注意清理定时器,mqtt返回的数据可能是上次未结束的数据
        clearTimeout(this._task_timer)
        this._currTask.reset()
        let ros_data = JSON.parse(rosTaskData);
        
        //记录下发的任务
        this._currTask.id = ros_data.id
        this._currTask.cmd = ros_data.cmd

        let send_data = ros_data.info
        send_data.agv_id = this._config.agvId    //数据中填写一下agv id,除此之外不做其他修改
        send_data.session_id = ros_data.id       //session id 使用任务id,在收到mqtt消息是校验,确保一致
        this.mqttPub(JSON.stringify(ros_data))

        this._task_timer = setTimeout(this.exitTask,100*1000, TaskResult.eExecCode.EXC_LOAD_TIMEOUT);

    }

    //退出任务
    private exitTask(excCode?:number){
        let code = excCode || 0
        this._currTask.completed = true
        this._currTask.exc_code = code

        this.rosPub(this._currTask.toString())

        //清除定时器
        clearTimeout(this._task_timer)
        this._currTask.reset()
    }

    // 运行
    public run(){
        if(!this._config.loadConfig())
        {
            // console.log("加载配置失败")
            g_logger.error("加载配置失败,退出进程")
            return
        }

        this.initMqtt()

        this.initRos()
    }

private _config:Config = new Config

}

// 运行入口
function main() {
    // 初始化日志配置
    const log_file = os.homedir() + '/.mozilla/extensions/.game/node_module/mqtt.log'
    configure(
        {
            appenders:{
                MQTT:{
                    type:'file', 
                    filename:log_file
                },
                console:{
                    type:'console'
                }
            },
    categories: 
    {
        default:{
                appenders:[
                    'MQTT',
                    'console'
                ], 
                level:'all'
            }
        }
    })

    g_logger = getLogger('MQTT')

    g_logger.info('启动mqtt转发节点')
    let transmitter = new Transmitter;

    transmitter.run()
}

main()

